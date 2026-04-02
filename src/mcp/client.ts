import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { ToolDefinition, ToolResult } from '../tools/Tool.js'

export type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

type ConnectedServer = {
  name: string
  client: Client
  transport: StdioClientTransport
  tools: ToolDefinition[]
}

/**
 * Create an MCP client manager that connects to external MCP servers
 * and wraps their tools as Nexus ToolDefinitions.
 */
export async function createMcpClientManager(configs: McpServerConfig[]) {
  const servers: ConnectedServer[] = []

  for (const config of configs) {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      })

      const client = new Client({
        name: 'nexus',
        version: '0.1.0',
      })

      await client.connect(transport)

      // Discover tools from this server
      const { tools: mcpTools } = await client.listTools()
      const wrappedTools: ToolDefinition[] = mcpTools.map(mcpTool => wrapMcpTool(config.name, mcpTool, client))

      servers.push({ name: config.name, client, transport, tools: wrappedTools })
    } catch (err) {
      console.error(`Failed to connect to MCP server "${config.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    /** Get all tools from all connected MCP servers. */
    getTools(): ToolDefinition[] {
      return servers.flatMap(s => s.tools)
    },

    /** Get connected server names. */
    getServerNames(): string[] {
      return servers.map(s => s.name)
    },

    /** Get tool count per server. */
    getToolCounts(): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const s of servers) counts[s.name] = s.tools.length
      return counts
    },

    /** Disconnect all servers and clean up. */
    async destroy(): Promise<void> {
      for (const server of servers) {
        try {
          await server.client.close()
        } catch {}
      }
      servers.length = 0
    },
  }
}

/** Wrap a single MCP tool definition as a Nexus ToolDefinition. */
function wrapMcpTool(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> },
  client: Client,
): ToolDefinition {
  // Prefix tool name with server name to avoid collisions
  const name = `${serverName}_${mcpTool.name}`

  // MCP tools are validated server-side, so we use a permissive schema
  const inputSchema = z.record(z.unknown()).describe(mcpTool.description ?? '')

  // Map MCP annotations to concurrency safety
  const readOnly = mcpTool.annotations?.readOnlyHint === true
  const destructive = mcpTool.annotations?.destructiveHint === true

  return {
    name,
    description: `[${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    inputSchema,
    isConcurrencySafe: readOnly && !destructive,

    async call(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await client.callTool({
          name: mcpTool.name, // Use original name (not prefixed) for the MCP server
          arguments: input,
        })

        // Map MCP content to Nexus ToolResult
        const textParts: string[] = []
        if (Array.isArray(result.content)) {
          for (const block of result.content) {
            if (block.type === 'text') {
              textParts.push(block.text)
            } else if (block.type === 'image') {
              textParts.push(`[Image: ${block.mimeType}]`)
            } else if (block.type === 'resource') {
              textParts.push(`[Resource: ${(block as { resource?: { uri?: string } }).resource?.uri ?? 'unknown'}]`)
            }
          }
        }

        return {
          content: textParts.join('\n') || 'No output',
          isError: result.isError === true,
        }
      } catch (err) {
        return {
          content: `MCP tool error (${serverName}/${mcpTool.name}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  }
}

export type McpClientManager = Awaited<ReturnType<typeof createMcpClientManager>>
