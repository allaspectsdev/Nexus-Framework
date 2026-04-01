import type { Message, ToolSchema, StreamEvent } from '../engine/types.js'
import type { Router } from '../routing/Router.js'
import type { NexusConfig } from '../config.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'
import type { TaskNotification } from './types.js'
import { createAgentRegistry, type AgentRegistry } from './AgentRegistry.js'
import { runWorker } from './Worker.js'
import { notificationToMessage } from './notifications.js'
import { queryLoop } from '../engine/QueryLoop.js'

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

  // Spawn workers based on the task (LLM-driven decomposition)
  const workerDirectives = await decomposeTask(options.task, options.router, options.config, options.signal)

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

type WorkerDirective = { name: string; purpose: string; instruction: string }

/**
 * LLM-driven task decomposition — uses the router to generate task-appropriate worker directives.
 * Falls back to heuristic decomposition if the LLM call fails.
 */
async function decomposeTask(
  task: string,
  router: Router,
  config: NexusConfig,
  signal?: AbortSignal,
): Promise<WorkerDirective[]> {
  try {
    const decision = await router.route(
      [{ role: 'user', content: [{ type: 'text', text: task }], turn: 0 }],
      'classify',
    )
    const client = router.getClient(decision.provider)

    const prompt = `Given this task, decompose it into 2-4 independent worker directives. Each worker should have a clear, non-overlapping scope.

Task: ${task}

Respond with a JSON array of objects, each with "name" (short lowercase identifier), "purpose" (one-line description), and "instruction" (detailed directive for the worker). Output ONLY the JSON array, nothing else.`

    let response = ''
    const stream = client.stream({
      model: decision.model,
      systemPrompt: 'You decompose tasks into parallel worker directives. Output only valid JSON.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], turn: 0 }],
      tools: [],
      maxTokens: 2000,
      signal,
    })

    for await (const event of stream) {
      if (event.type === 'text_delta') response += event.text
    }

    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = response.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ name: string; purpose: string; instruction: string }>
      if (Array.isArray(parsed) && parsed.length >= 2 && parsed.length <= 4) {
        return parsed.map(d => ({
          name: String(d.name).toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
          purpose: String(d.purpose),
          instruction: String(d.instruction),
        }))
      }
    }
  } catch {
    // Fall through to heuristic decomposition
  }

  return heuristicDecompose(task)
}

/** Fallback heuristic decomposition based on task content. */
function heuristicDecompose(task: string): WorkerDirective[] {
  const lower = task.toLowerCase()

  // Code-related tasks
  if (/\b(code|implement|build|refactor|fix|debug)\b/.test(lower)) {
    return [
      { name: 'planner', purpose: 'Plan implementation approach', instruction: `${task}\n\nAnalyze the task requirements and existing code. Identify the files that need to be modified, the approach to take, and any potential issues.` },
      { name: 'implementer', purpose: 'Write the code changes', instruction: `${task}\n\nFocus on implementing the required changes. Write clean, well-structured code that follows the project's existing patterns.` },
      { name: 'validator', purpose: 'Validate and review changes', instruction: `${task}\n\nReview the implementation for correctness, edge cases, and potential issues. Check that it follows project conventions.` },
    ]
  }

  // Analysis tasks
  if (/\b(analyze|review|audit|investigate|explore)\b/.test(lower)) {
    return [
      { name: 'explorer', purpose: 'Map project structure', instruction: `${task}\n\nFocus on understanding the project structure: read key config files, list directories, and identify the main source files and their purposes.` },
      { name: 'analyzer', purpose: 'Deep-dive into patterns', instruction: `${task}\n\nFocus on analyzing code patterns: search for key function definitions, import patterns, and architectural decisions in the source code.` },
      { name: 'reviewer', purpose: 'Assess quality and issues', instruction: `${task}\n\nFocus on code quality: look for potential bugs, security issues, error handling patterns, and test coverage. Check for common anti-patterns.` },
    ]
  }

  // Default: general-purpose split
  return [
    { name: 'researcher', purpose: 'Gather context and information', instruction: `${task}\n\nFocus on gathering all relevant context: read files, search for patterns, and build a comprehensive understanding of what's needed.` },
    { name: 'executor', purpose: 'Execute the primary task', instruction: `${task}\n\nFocus on the core work: complete the main deliverable of this task using the available tools.` },
    { name: 'reviewer', purpose: 'Review and validate results', instruction: `${task}\n\nFocus on reviewing the work: verify correctness, check for issues, and ensure quality.` },
  ]
}

export { type AgentRegistry }
