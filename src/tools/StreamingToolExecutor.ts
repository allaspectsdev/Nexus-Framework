import type { ToolUseBlock } from '../engine/types.js'
import type { ToolDefinition, ToolResult } from './Tool.js'
import type { ToolRegistry } from './ToolRegistry.js'
import { createSiblingAbort } from '../utils/abort.js'

type PendingTool = {
  toolUse: ToolUseBlock
  definition: ToolDefinition
}

type CompletedTool = {
  toolUse: ToolUseBlock
  result: ToolResult
  durationMs: number
  concurrent: boolean
}

/**
 * Streaming tool executor — starts executing tools while the model is still streaming.
 * Read-only (concurrency-safe) tools run in parallel. Write tools queue and run serially.
 * Pattern from Claude Code's StreamingToolExecutor.ts.
 */
export function createStreamingToolExecutor(
  registry: ToolRegistry,
  parentSignal?: AbortSignal,
) {
  const siblingAbort = createSiblingAbort(parentSignal)
  const completed: CompletedTool[] = []
  const running: Map<string, Promise<void>> = new Map()
  const pending: PendingTool[] = []
  let concurrentBatch: Promise<void>[] = []

  async function executeTool(
    toolUse: ToolUseBlock,
    definition: ToolDefinition,
    concurrent: boolean,
  ): Promise<CompletedTool> {
    const start = performance.now()
    try {
      // Concurrent tools use siblingAbort (error in one cancels siblings).
      // Serial tools use parentSignal only (sibling errors shouldn't cancel writes).
      const signal = concurrent ? siblingAbort.signal : parentSignal
      const result = await definition.call(
        definition.inputSchema.parse(toolUse.input),
        signal,
      )
      return {
        toolUse,
        result,
        durationMs: performance.now() - start,
        concurrent,
      }
    } catch (error) {
      // Abort sibling concurrent tools on error (Claude Code pattern)
      if (concurrent) {
        siblingAbort.abort(error)
      }
      return {
        toolUse,
        result: {
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        },
        durationMs: performance.now() - start,
        concurrent,
      }
    }
  }

  return {
    /** Add a tool use block as it arrives from streaming. */
    addTool(toolUse: ToolUseBlock): void {
      const definition = registry.getTool(toolUse.name)
      if (!definition) {
        completed.push({
          toolUse,
          result: { content: `Unknown tool: ${toolUse.name}`, isError: true },
          durationMs: 0,
          concurrent: false,
        })
        return
      }

      if (definition.isConcurrencySafe) {
        // Start immediately in parallel — collect result via promise
        const promise = executeTool(toolUse, definition, true).then(result => {
          completed.push(result)
        })
        running.set(toolUse.id, promise)
        concurrentBatch.push(promise)
      } else {
        // Queue for serial execution after concurrent batch completes
        pending.push({ toolUse, definition })
      }
    },

    /** Drain all results — wait for concurrent tools, then execute serial tools. */
    async *drain(): AsyncGenerator<CompletedTool> {
      // Wait for all concurrent tools to finish
      if (concurrentBatch.length > 0) {
        await Promise.allSettled(concurrentBatch)
        concurrentBatch = []
      }

      // Yield completed concurrent results
      while (completed.length > 0) {
        yield completed.shift()!
      }

      // Execute pending serial tools one at a time
      for (const { toolUse, definition } of pending) {
        const result = await executeTool(toolUse, definition, false)
        yield result
      }
      pending.length = 0
    },

    /** Get all completed results without waiting. */
    getCompleted(): CompletedTool[] {
      return [...completed]
    },

    /** Cancel all running and pending tools. */
    cancel(): void {
      siblingAbort.abort(new Error('Executor cancelled'))
      pending.length = 0
    },
  }
}

export type StreamingToolExecutor = ReturnType<typeof createStreamingToolExecutor>
export type { CompletedTool }
