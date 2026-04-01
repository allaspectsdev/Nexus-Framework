import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import type { MetricsCollector } from '../observability/MetricsCollector.js'
import type { EventBus } from '../observability/EventBus.js'
import type { QueryLoopOptions } from '../engine/QueryLoop.js'
import type { Message } from '../engine/types.js'
import { queryLoop } from '../engine/QueryLoop.js'
import { runCoordinator } from '../agents/Coordinator.js'

// Resolve paths relative to this file, not CWD
const __dirname = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = resolve(__dirname, 'static')

export type QueryDeps = Omit<QueryLoopOptions, 'onEvent' | 'onRoute' | 'onTransition' | 'onContextAction' | 'signal' | 'maxTurns' | 'purpose'>

const querySchema = z.object({
  query: z.string().min(1),
  mode: z.enum(['single', 'multi']).default('single'),
})

export function createDashboardServer(
  port: number,
  metricsCollector: MetricsCollector,
  eventBus: EventBus,
  queryDeps?: QueryDeps,
) {
  const app = new Hono()

  // Serve static files using absolute path
  app.use('/static/*', serveStatic({ root: STATIC_DIR }))

  // SSE endpoint — push events to the dashboard in real time
  app.get('/events', (c) => {
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => void) | undefined

    function cleanup() {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    }

    return c.newResponse(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          // Send initial metrics snapshot
          const initial = JSON.stringify({
            type: 'snapshot',
            metrics: metricsCollector.getMetrics(),
            savings: metricsCollector.getSavings(),
            uptime: metricsCollector.getUptime(),
            recentEvents: metricsCollector.getRecentEvents().slice(-50),
          })
          controller.enqueue(encoder.encode(`data: ${initial}\n\n`))

          // Subscribe to live events
          unsubscribe = eventBus.on((event) => {
            if (closed) return
            try {
              const data = JSON.stringify({
                type: 'event',
                event,
                metrics: metricsCollector.getMetrics(),
                savings: metricsCollector.getSavings(),
                uptime: metricsCollector.getUptime(),
                timestamp: Date.now(),
              })
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            } catch {
              cleanup()
            }
          })

          // Send heartbeat every 15s
          heartbeat = setInterval(() => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`))
            } catch {
              cleanup()
            }
          }, 15_000)
        },
        cancel() {
          cleanup()
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    )
  })

  // REST endpoint for current metrics
  app.get('/api/metrics', (c) => {
    return c.json({
      metrics: metricsCollector.getMetrics(),
      savings: metricsCollector.getSavings(),
      uptime: metricsCollector.getUptime(),
    })
  })

  // POST /api/query — run a query through the engine and stream events back
  app.post('/api/query', async (c) => {
    if (!queryDeps) {
      return c.json({ error: 'Query engine not available' }, 503)
    }

    const body = querySchema.safeParse(await c.req.json())
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400)
    }

    const { query, mode } = body.data
    let queryAbort: AbortController | undefined
    let closed = false

    return c.newResponse(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const send = (data: unknown) => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            } catch {
              closed = true
            }
          }

          queryAbort = new AbortController()
          const messages: Message[] = [{
            role: 'user',
            content: [{ type: 'text', text: query }],
            turn: 0,
          }]

          try {
            if (mode === 'single') {
              const loop = queryLoop(messages, {
                ...queryDeps,
                signal: queryAbort.signal,
                purpose: 'reason',
                onEvent(event) {
                  send(event)
                  // Emit to eventBus for dashboard metrics
                  if (event.type === 'text_delta') {
                    eventBus.emit({ type: 'stream_text', text: event.text, provider: 'claude' })
                  }
                  if (event.type === 'tool_use_complete') {
                    eventBus.emit({ type: 'tool_execution', tool: event.name, durationMs: 0, concurrent: false, isError: false })
                  }
                  if (event.type === 'message_complete') {
                    eventBus.emit({
                      type: 'token_usage',
                      provider: event.message.provider ?? 'claude',
                      inputTokens: event.usage.inputTokens,
                      outputTokens: event.usage.outputTokens,
                      cachedTokens: event.usage.cacheReadTokens,
                      cost: (event.usage.inputTokens / 1_000_000) * 3 + (event.usage.outputTokens / 1_000_000) * 15,
                    })
                  }
                },
                onRoute(decision) {
                  send({ type: 'routing_decision', provider: decision.provider, reason: decision.reason })
                  eventBus.emit({ type: 'routing_decision', provider: decision.provider, reason: decision.reason, inputTokens: 0 })
                },
                onContextAction(action) {
                  if (action.type === 'compact') {
                    eventBus.emit({ type: 'compaction', tokensBefore: 0, tokensAfter: 0, tokensSaved: action.tokensSaved })
                  } else {
                    eventBus.emit({ type: 'context_decay', tier: action.type, tokensSaved: action.tokensSaved, messageCount: 1 })
                  }
                },
              })

              let result = await loop.next()
              while (!result.done) {
                result = await loop.next()
              }
              send({ type: 'done', reason: result.value.reason })
            } else {
              // Multi-agent mode
              const coordinator = runCoordinator({
                task: query,
                systemPrompt: queryDeps.systemPrompt,
                tools: queryDeps.tools,
                toolRegistry: queryDeps.toolRegistry!,
                router: queryDeps.router,
                config: queryDeps.config,
                signal: queryAbort.signal,
                onEvent(event, data) {
                  send({ type: 'agent_event', event, data })
                  // Emit agent lifecycle to eventBus
                  if (event === 'worker_spawned') {
                    const d = data as { id: string; name: string; purpose: string }
                    eventBus.emit({ type: 'agent_lifecycle', agentId: d.id, name: d.name, status: 'running' })
                  } else if (event === 'worker_completed') {
                    const d = data as { taskId: string; name: string; usage: { totalTokens: number; durationMs: number } }
                    eventBus.emit({ type: 'agent_lifecycle', agentId: d.taskId, name: d.name, status: 'completed', durationMs: d.usage?.durationMs })
                  }
                },
              })

              for await (const event of coordinator) {
                send(event)
                if (event.type === 'message_complete') {
                  eventBus.emit({
                    type: 'token_usage',
                    provider: event.message.provider ?? 'claude',
                    inputTokens: event.usage.inputTokens,
                    outputTokens: event.usage.outputTokens,
                    cachedTokens: event.usage.cacheReadTokens,
                    cost: (event.usage.inputTokens / 1_000_000) * 3 + (event.usage.outputTokens / 1_000_000) * 15,
                  })
                }
              }
              send({ type: 'done', reason: 'completed' })
            }
          } catch (err) {
            if (!queryAbort?.signal.aborted) {
              send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
            }
          } finally {
            try { controller.close() } catch {}
          }
        },
        cancel() {
          closed = true
          queryAbort?.abort('client_disconnect')
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    )
  })

  // Serve index.html at root
  app.get('/', (c) => {
    return c.html(Bun.file(resolve(STATIC_DIR, 'index.html')).text())
  })

  return {
    start() {
      console.log(`Dashboard: http://localhost:${port}`)
      return Bun.serve({ port, fetch: app.fetch })
    },
  }
}
