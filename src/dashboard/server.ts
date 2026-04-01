import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { MetricsCollector } from '../observability/MetricsCollector.js'
import type { EventBus } from '../observability/EventBus.js'

// Resolve paths relative to this file, not CWD
const __dirname = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = resolve(__dirname, 'static')

export function createDashboardServer(
  port: number,
  metricsCollector: MetricsCollector,
  eventBus: EventBus,
) {
  const app = new Hono()

  // Serve static files using absolute path
  app.use('/static/*', serveStatic({ root: resolve(__dirname, '..', '..') + '/src/dashboard/' }))

  // SSE endpoint — push events to the dashboard in real time
  app.get('/events', (c) => {
    return c.newResponse(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          let closed = false

          function cleanup() {
            if (closed) return
            closed = true
            clearInterval(heartbeat)
            unsubscribe()
          }

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
          const unsubscribe = eventBus.on((event) => {
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
              cleanup() // Fix: clean up on enqueue failure too
            }
          })

          // Send heartbeat every 15s
          const heartbeat = setInterval(() => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`))
            } catch {
              cleanup()
            }
          }, 15_000)
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
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
