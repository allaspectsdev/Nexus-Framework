import type { EventBus, MetricEvent } from './EventBus.js'

// Pricing per MTok (Sonnet 4 defaults)
const PRICING = {
  claude: { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  local: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
}

export type Metrics = {
  claude: { inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; calls: number }
  local: { inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; calls: number }
  routing: { localDecisions: number; claudeDecisions: number }
  agents: { spawned: number; completed: number; failed: number }
  tools: { executions: number; concurrent: number; errors: number; totalDurationMs: number }
  context: { decayActions: number; tokensSaved: number; compactions: number }
  startedAt: number
}

export function createMetricsCollector(eventBus: EventBus) {
  const metrics: Metrics = {
    claude: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, calls: 0 },
    local: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, calls: 0 },
    routing: { localDecisions: 0, claudeDecisions: 0 },
    agents: { spawned: 0, completed: 0, failed: 0 },
    tools: { executions: 0, concurrent: 0, errors: 0, totalDurationMs: 0 },
    context: { decayActions: 0, tokensSaved: 0, compactions: 0 },
    startedAt: Date.now(),
  }

  // Recent events for the dashboard timeline
  const recentEvents: Array<MetricEvent & { timestamp: number }> = []
  const MAX_RECENT = 200

  const unsubscribe = eventBus.on((event) => {
    recentEvents.push({ ...event, timestamp: Date.now() })
    if (recentEvents.length > MAX_RECENT) recentEvents.shift()

    switch (event.type) {
      case 'token_usage': {
        const bucket = metrics[event.provider]
        bucket.inputTokens += event.inputTokens
        bucket.outputTokens += event.outputTokens
        bucket.cachedTokens += event.cachedTokens
        bucket.cost += event.cost
        bucket.calls++
        break
      }
      case 'routing_decision':
        if (event.provider === 'local') metrics.routing.localDecisions++
        else metrics.routing.claudeDecisions++
        break
      case 'agent_lifecycle':
        if (event.status === 'running') metrics.agents.spawned++
        else if (event.status === 'completed') metrics.agents.completed++
        else if (event.status === 'failed') metrics.agents.failed++
        break
      case 'tool_execution':
        metrics.tools.executions++
        if (event.concurrent) metrics.tools.concurrent++
        if (event.isError) metrics.tools.errors++
        metrics.tools.totalDurationMs += event.durationMs
        break
      case 'context_decay':
        metrics.context.decayActions += event.messageCount
        metrics.context.tokensSaved += event.tokensSaved
        break
      case 'compaction':
        metrics.context.compactions++
        metrics.context.tokensSaved += event.tokensSaved
        break
    }
  })

  return {
    getMetrics(): Metrics {
      return { ...metrics }
    },

    getRecentEvents(): Array<MetricEvent & { timestamp: number }> {
      return [...recentEvents]
    },

    /** Calculate estimated savings vs. sending everything to Claude. */
    getSavings(): { tokensSaved: number; costSaved: number; percentSaved: number } {
      // If local tokens had gone to Claude instead (split by input/output pricing):
      const hypotheticalInputCost = (metrics.local.inputTokens / 1_000_000) * PRICING.claude.input
      const hypotheticalOutputCost = (metrics.local.outputTokens / 1_000_000) * PRICING.claude.output
      const hypotheticalCost = hypotheticalInputCost + hypotheticalOutputCost

      // Context decay saves future input tokens (decayed content is not re-sent)
      const decaySavings = (metrics.context.tokensSaved / 1_000_000) * PRICING.claude.input

      const actualCost = metrics.claude.cost + metrics.local.cost
      const totalCost = hypotheticalCost + decaySavings + metrics.claude.cost

      return {
        tokensSaved: metrics.context.tokensSaved + metrics.local.inputTokens + metrics.local.outputTokens,
        costSaved: hypotheticalCost + decaySavings,
        percentSaved: totalCost > 0 ? ((totalCost - actualCost) / totalCost) * 100 : 0,
      }
    },

    getUptime(): number {
      return Date.now() - metrics.startedAt
    },

    /** Unsubscribe from EventBus to prevent listener leaks. */
    destroy(): void {
      unsubscribe()
    },
  }
}

export type MetricsCollector = ReturnType<typeof createMetricsCollector>
