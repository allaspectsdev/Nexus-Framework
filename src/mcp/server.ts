import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { MetricsCollector } from '../observability/MetricsCollector.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { QueryLoopOptions } from '../engine/QueryLoop.js'
import type { NexusConfig } from '../config.js'
import { queryLoop } from '../engine/QueryLoop.js'
import type { Message } from '../engine/types.js'

export type McpServerDeps = {
  metricsCollector: MetricsCollector
  agentRegistry?: AgentRegistry
  /** Provide these to enable nexus_query — omit for metrics-only mode */
  queryDeps?: Omit<QueryLoopOptions, 'onEvent' | 'onRoute' | 'onTransition' | 'onContextAction' | 'signal' | 'maxTurns' | 'purpose'>
  config?: NexusConfig
}

export function createMcpServer(deps: McpServerDeps) {
  const { metricsCollector, agentRegistry } = deps

  const server = new McpServer({
    name: 'nexus',
    version: '0.1.0',
  })

  // Tool: nexus_status — get current metrics and agent state
  server.tool(
    'nexus_status',
    'Get current Nexus metrics: token usage, costs, savings, agent status',
    {},
    async () => {
      const metrics = metricsCollector.getMetrics()
      const savings = metricsCollector.getSavings()
      const agents = agentRegistry?.getAll() ?? []

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ metrics, savings, agents }, null, 2),
        }],
      }
    },
  )

  // Tool: nexus_query — run a query through the hybrid engine
  server.tool(
    'nexus_query',
    'Run a query through Nexus hybrid routing engine (local + Claude)',
    { query: z.string().describe('The query to process') },
    async ({ query }) => {
      if (!deps.queryDeps) {
        return {
          content: [{
            type: 'text',
            text: `MCP server running in metrics-only mode. Query: "${query}"\nStatus: ${JSON.stringify(metricsCollector.getSavings())}`,
          }],
        }
      }

      // Wire through the real QueryLoop
      const messages: Message[] = [{
        role: 'user',
        content: [{ type: 'text', text: query }],
        turn: 0,
      }]

      let responseText = ''
      const loop = queryLoop(messages, {
        ...deps.queryDeps,
        maxTurns: 10,
        purpose: 'reason',
      })

      let result = await loop.next()
      while (!result.done) {
        if (result.value.type === 'text_delta') {
          responseText += result.value.text
        }
        result = await loop.next()
      }

      return {
        content: [{
          type: 'text',
          text: responseText || `Query completed with status: ${result.value.reason}`,
        }],
      }
    },
  )

  // Tool: nexus_configure — adjust runtime configuration
  server.tool(
    'nexus_configure',
    'Adjust Nexus runtime configuration (routing thresholds, model preferences)',
    {
      setting: z.enum(['routing_threshold', 'decay_full_turns', 'decay_summary_turns']),
      value: z.number(),
    },
    async ({ setting, value }) => {
      if (deps.config) {
        switch (setting) {
          case 'routing_threshold':
            deps.config.routingComplexityThreshold = value
            break
          case 'decay_full_turns':
            deps.config.contextDecayFullTurns = value
            break
          case 'decay_summary_turns':
            deps.config.contextDecaySummaryTurns = value
            break
        }
        return {
          content: [{
            type: 'text',
            text: `Configuration updated: ${setting} = ${value}`,
          }],
        }
      }
      return {
        content: [{
          type: 'text',
          text: `Cannot update configuration in metrics-only mode`,
        }],
        isError: true,
      }
    },
  )

  // Resource: nexus://metrics
  server.resource(
    'nexus://metrics',
    'nexus://metrics',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          metrics: metricsCollector.getMetrics(),
          savings: metricsCollector.getSavings(),
          uptime: metricsCollector.getUptime(),
        }, null, 2),
      }],
    }),
  )

  return {
    async startStdio() {
      const transport = new StdioServerTransport()
      await server.connect(transport)
      return server
    },

    getServer() {
      return server
    },
  }
}
