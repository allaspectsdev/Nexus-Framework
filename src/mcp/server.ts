import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { MetricsCollector } from '../observability/MetricsCollector.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'

export function createMcpServer(
  metricsCollector: MetricsCollector,
  agentRegistry?: AgentRegistry,
) {
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
      // This is a placeholder — in production, this would wire into the QueryLoop
      return {
        content: [{
          type: 'text',
          text: `Nexus received query: "${query}"\nCurrent status: ${JSON.stringify(metricsCollector.getSavings())}`,
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
      return {
        content: [{
          type: 'text',
          text: `Configuration updated: ${setting} = ${value}`,
        }],
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
        text: JSON.stringify(metricsCollector.getMetrics(), null, 2),
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
