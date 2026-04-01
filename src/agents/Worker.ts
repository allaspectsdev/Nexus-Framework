import type { Message, ToolSchema } from '../engine/types.js'
import type { Router } from '../routing/Router.js'
import type { NexusConfig } from '../config.js'
import type { ToolExecutor } from '../engine/QueryLoop.js'
import type { AgentId, TaskNotification } from './types.js'
import type { AgentRegistry } from './AgentRegistry.js'
import { queryLoop } from '../engine/QueryLoop.js'
import { createChildAbort } from '../utils/abort.js'

export type WorkerOptions = {
  id: AgentId
  name: string
  directive: string
  systemPrompt: string
  tools: ToolSchema[]
  toolExecutor: ToolExecutor
  router: Router
  config: NexusConfig
  registry: AgentRegistry
  parentSignal?: AbortSignal
  onEvent?: (agentId: AgentId, event: string) => void
}

/**
 * Run a worker agent — an independent QueryLoop with its own context.
 * Returns a TaskNotification when complete.
 */
export async function runWorker(options: WorkerOptions): Promise<TaskNotification> {
  const { id, name, directive, registry } = options
  const childAbort = createChildAbort(options.parentSignal)
  const startTime = Date.now()
  let toolUseCount = 0
  let totalTokens = 0

  registry.update(id, { status: 'running' })
  options.onEvent?.(id, 'started')

  const messages: Message[] = [{
    role: 'user',
    content: [{ type: 'text', text: directive }],
    turn: 0,
  }]

  let lastAssistantText = ''

  try {
    const loop = queryLoop(messages, {
      systemPrompt: options.systemPrompt + `\n\nYou are worker agent "${name}". Complete the task and respond with a concise summary of what you did and found.`,
      tools: options.tools,
      toolExecutor: options.toolExecutor,
      router: options.router,
      config: options.config,
      maxTurns: 20,
      signal: childAbort.signal,
      purpose: 'reason',
      onEvent(event) {
        if (event.type === 'message_complete') {
          totalTokens += event.usage.inputTokens + event.usage.outputTokens
          const textBlocks = event.message.content.filter(b => b.type === 'text')
          if (textBlocks.length > 0) {
            lastAssistantText = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n')
          }
        }
        if (event.type === 'tool_use_complete') {
          toolUseCount++
        }
      },
    })

    // Drain the generator
    let result = await loop.next()
    while (!result.done) {
      result = await loop.next()
    }

    const durationMs = Date.now() - startTime

    registry.update(id, {
      status: 'completed',
      completedAt: Date.now(),
      toolUseCount,
      totalTokens,
      result: lastAssistantText,
    })

    options.onEvent?.(id, 'completed')

    return {
      taskId: id,
      name,
      status: 'completed',
      summary: lastAssistantText.slice(0, 500),
      result: lastAssistantText,
      usage: { totalTokens, toolUses: toolUseCount, durationMs },
    }
  } catch (error) {
    const durationMs = Date.now() - startTime
    const errorMsg = error instanceof Error ? error.message : String(error)

    registry.update(id, {
      status: 'failed',
      completedAt: Date.now(),
      error: errorMsg,
    })

    options.onEvent?.(id, `failed: ${errorMsg}`)

    return {
      taskId: id,
      name,
      status: 'failed',
      summary: `Worker "${name}" failed: ${errorMsg}`,
      usage: { totalTokens, toolUses: toolUseCount, durationMs },
    }
  }
}
