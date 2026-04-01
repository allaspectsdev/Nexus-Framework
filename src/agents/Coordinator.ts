import type { Message, ToolSchema } from '../engine/types.js'
import type { Router } from '../routing/Router.js'
import type { NexusConfig } from '../config.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'
import type { TaskNotification } from './types.js'
import { createAgentRegistry, type AgentRegistry } from './AgentRegistry.js'
import { runWorker } from './Worker.js'
import { notificationToMessage } from './notifications.js'
import { queryLoop } from '../engine/QueryLoop.js'
import type { StreamEvent } from '../engine/types.js'

export type CoordinatorOptions = {
  task: string
  systemPrompt: string
  tools: ToolSchema[]
  toolRegistry: ToolRegistry
  router: Router
  config: NexusConfig
  signal?: AbortSignal
  onEvent?: (event: string, data?: unknown) => void
}

const COORDINATOR_PROMPT = `You are a coordinator agent. Your job is to break down tasks and delegate to worker agents.

You have these special tools:
- spawn_worker: Launch a worker agent with a specific directive
- send_message: Send a message to a running worker (for follow-up instructions)

Workflow:
1. Analyze the task
2. Spawn 2-4 workers with specific, non-overlapping directives
3. Wait for their <task-notification> results
4. Synthesize findings into a final response

Rules:
- Workers run in parallel — give each a clear, independent scope
- Don't duplicate work across workers
- Synthesize results — don't just concatenate them
`

/**
 * Run a coordinator that spawns and manages worker agents.
 * Pattern from Claude Code's coordinatorMode.ts.
 */
export async function* runCoordinator(
  options: CoordinatorOptions,
): AsyncGenerator<StreamEvent, { notifications: TaskNotification[] }> {
  const registry = createAgentRegistry()
  const notifications: TaskNotification[] = []
  const pendingWorkers: Promise<TaskNotification>[] = []

  options.onEvent?.('coordinator_started', { task: options.task })

  // Spawn workers based on the task
  const workerDirectives = decomposeTask(options.task)

  for (const directive of workerDirectives) {
    const agent = registry.register(directive.name, directive.purpose)
    options.onEvent?.('worker_spawned', { id: agent.id, name: directive.name, purpose: directive.purpose })

    const workerPromise = runWorker({
      id: agent.id,
      name: directive.name,
      directive: directive.instruction,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      toolExecutor: options.toolRegistry,
      router: options.router,
      config: options.config,
      registry,
      parentSignal: options.signal,
      onEvent: (agentId, event) => {
        options.onEvent?.('worker_event', { agentId, event })
      },
    })

    pendingWorkers.push(workerPromise)
  }

  // Wait for all workers to complete
  const results = await Promise.allSettled(pendingWorkers)

  for (const result of results) {
    if (result.status === 'fulfilled') {
      notifications.push(result.value)
      options.onEvent?.('worker_completed', result.value)
    } else {
      options.onEvent?.('worker_failed', { error: result.reason })
    }
  }

  // Now run the coordinator's own query loop to synthesize results
  const coordinatorMessages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `Task: ${options.task}\n\nYour workers have completed. Synthesize their results into a comprehensive response.` }],
      turn: 0,
    },
    // Inject worker notifications
    ...notifications.map((n, i) => notificationToMessage(n, i + 1)),
  ]

  const loop = queryLoop(coordinatorMessages, {
    systemPrompt: COORDINATOR_PROMPT + '\n\n' + options.systemPrompt,
    tools: [], // Coordinator doesn't need tools for synthesis
    toolExecutor: options.toolRegistry,
    router: options.router,
    config: options.config,
    maxTurns: 3,
    signal: options.signal,
    purpose: 'reason',
  })

  let result = await loop.next()
  while (!result.done) {
    yield result.value
    result = await loop.next()
  }

  options.onEvent?.('coordinator_completed', {
    workerCount: notifications.length,
    totalTokens: notifications.reduce((sum, n) => sum + n.usage.totalTokens, 0),
  })

  return { notifications }
}

/** Simple task decomposition — split a task into worker directives. */
function decomposeTask(task: string): Array<{ name: string; purpose: string; instruction: string }> {
  // For the demo, create 3 standard workers for codebase analysis tasks
  return [
    {
      name: 'explorer',
      purpose: 'Explore project structure',
      instruction: `${task}\n\nFocus on understanding the project structure: read key config files (package.json, tsconfig.json, etc.), list directories, and identify the main source files and their purposes.`,
    },
    {
      name: 'analyzer',
      purpose: 'Analyze code patterns',
      instruction: `${task}\n\nFocus on analyzing code patterns: search for key function definitions, class structures, import patterns, and architectural decisions in the source code.`,
    },
    {
      name: 'reviewer',
      purpose: 'Review code quality',
      instruction: `${task}\n\nFocus on code quality: look for potential bugs, security issues, error handling patterns, and test coverage. Check for common anti-patterns.`,
    },
  ]
}

export { type AgentRegistry }
