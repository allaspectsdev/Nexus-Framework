import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import type { MetricsCollector } from '../observability/MetricsCollector.js'
import type { EventBus, MetricEvent } from '../observability/EventBus.js'

export function createDashboardServer(
  port: number,
  metricsCollector: MetricsCollector,
  eventBus: EventBus,
) {
  const app = new Hono()

  // Serve static files
  app.use('/static/*', serveStatic({ root: './src/dashboard/' }))

  // SSE endpoint — push events to the dashboard in real time
  app.get('/events', (c) => {
    return c.newResponse(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          // Send initial metrics snapshot
          const initial = JSON.stringify({
            type: 'snapshot',
            metrics: metricsCollector.getMetrics(),
            savings: metricsCollector.getSavings(),
            recentEvents: metricsCollector.getRecentEvents().slice(-50),
          })
          controller.enqueue(encoder.encode(`data: ${initial}\n\n`))

          // Subscribe to live events
          const unsubscribe = eventBus.on((event) => {
            try {
              const data = JSON.stringify({
                type: 'event',
                event,
                metrics: metricsCollector.getMetrics(),
                savings: metricsCollector.getSavings(),
                timestamp: Date.now(),
              })
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            } catch {
              // Client disconnected
            }
          })

          // Send heartbeat every 15s
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`))
            } catch {
              clearInterval(heartbeat)
              unsubscribe()
            }
          }, 15_000)

          // Cleanup will happen via heartbeat error detection
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
    return c.html(Bun.file('./src/dashboard/static/index.html').text())
  })

  return {
    start() {
      console.log(`Dashboard: http://localhost:${port}`)
      return Bun.serve({ port, fetch: app.fetch })
    },
  }
}
