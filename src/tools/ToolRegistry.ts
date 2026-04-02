import type { ToolUseBlock, ToolSchema } from '../engine/types.js'
import type { ToolDefinition, ToolResult } from './Tool.js'
import { toolToSchema } from './Tool.js'
import type { ToolExecutor } from '../engine/QueryLoop.js'

export function createToolRegistry(tools: ToolDefinition[]): ToolExecutor & {
  getSchemas(): ToolSchema[]
  getTool(name: string): ToolDefinition | undefined
  getTools(): ToolDefinition[]
  registerTools(newTools: ToolDefinition[]): void
} {
  const toolMap = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    toolMap.set(tool.name, tool)
  }

  return {
    getSchemas(): ToolSchema[] {
      return [...toolMap.values()].map(toolToSchema)
    },

    getTool(name: string): ToolDefinition | undefined {
      return toolMap.get(name)
    },

    getTools(): ToolDefinition[] {
      return [...toolMap.values()]
    },

    /** Register additional tools dynamically (e.g., from MCP servers). */
    registerTools(newTools: ToolDefinition[]): void {
      for (const tool of newTools) {
        toolMap.set(tool.name, tool)
      }
    },

    async execute(toolUse: ToolUseBlock, signal?: AbortSignal): Promise<ToolResult> {
      const tool = toolMap.get(toolUse.name)
      if (!tool) {
        return { content: `Unknown tool: ${toolUse.name}`, isError: true }
      }

      // Validate input
      const parsed = tool.inputSchema.safeParse(toolUse.input)
      if (!parsed.success) {
        return {
          content: `Invalid input for ${toolUse.name}: ${parsed.error.message}`,
          isError: true,
        }
      }

      return tool.call(parsed.data, signal)
    },
  }
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>
