import type { Message, StreamEvent, ToolSchema, ContentBlock, ToolUseBlock, TokenUsage } from './types.js'
import type { Terminal, Continue, Transition } from './transitions.js'
import type { TurnSnapshot } from '../observer/types.js'
import type { Router } from '../routing/Router.js'
import type { NexusConfig } from '../config.js'
import type { ContextManager } from '../context/ContextManager.js'
import type { CompactionStrategy } from '../context/CompactionStrategy.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'
import { createStreamingToolExecutor } from '../tools/StreamingToolExecutor.js'
import { estimateMessageTokens } from '../utils/tokens.js'

export type ToolExecutor = {
  execute(toolUse: ToolUseBlock, signal?: AbortSignal): Promise<{ content: string; isError?: boolean }>
}

export type QueryLoopOptions = {
  systemPrompt: string
  tools: ToolSchema[]
  toolExecutor: ToolExecutor
  /** Full registry needed for StreamingToolExecutor concurrency checks */
  toolRegistry?: ToolRegistry
  router: Router
  config: NexusConfig
  /** Context decay engine — applies tiered decay before each API call */
  contextManager?: ContextManager
  /** Compaction strategy — summarizes old messages when context is too large */
  compactionStrategy?: CompactionStrategy
  maxTurns?: number
  signal?: AbortSignal
  /** Optional purpose hint for routing (e.g., 'summarize', 'reason') */
  purpose?: string
  /** Callback for every stream event */
  onEvent?: (event: StreamEvent) => void
  /** Callback for routing decisions */
  onRoute?: (decision: { provider: string; reason: string }) => void
  /** Callback for transitions */
  onTransition?: (transition: Transition) => void
  /** Callback for context management actions */
  onContextAction?: (action: { type: string; tokensSaved: number }) => void
  /** Called at turn boundaries for the observer system. Receives a frozen snapshot. */
  onTurnComplete?: (snapshot: TurnSnapshot) => void | Promise<void>
}

type QueryState = {
  messages: Message[]
  turnCount: number
  maxTokensOverride?: number
  recoveryCount: number
  totalUsage: TokenUsage
  transition?: Transition
}

const DEFAULT_MAX_TOKENS = 8192
const ESCALATED_MAX_TOKENS = 64000
const MAX_RECOVERY_ATTEMPTS = 3
const DEFAULT_MAX_TURNS = 50

function createTurnSnapshot(state: QueryState, toolUseBlocks: ToolUseBlock[], transition: Transition): TurnSnapshot {
  const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant')
  const lastAssistantText = lastAssistant?.content
    .filter(b => b.type === 'text')
    .map(b => b.type === 'text' ? b.text : '')
    .join('\n') ?? ''

  return {
    messages: [...state.messages],
    turnCount: state.turnCount,
    totalUsage: { ...state.totalUsage },
    transition,
    toolUseBlocks: [...toolUseBlocks],
    lastAssistantText,
    timestamp: Date.now(),
  }
}

/**
 * The flat state-machine query loop.
 * Pattern: Claude Code's query.ts — while(true) with explicit transitions.
 * No recursion, no callbacks for control flow, explicit state snapshots.
 */
export async function* queryLoop(
  initialMessages: Message[],
  options: QueryLoopOptions,
): AsyncGenerator<StreamEvent, Terminal> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS

  let state: QueryState = {
    messages: [...initialMessages],
    turnCount: 0,
    recoveryCount: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  }

  while (true) {
    // --- Check abort ---
    if (options.signal?.aborted) {
      const terminal: Terminal = { type: 'terminal', reason: 'aborted' }
      options.onTransition?.(terminal)
      return terminal
    }

    // --- Check max turns ---
    if (state.turnCount >= maxTurns) {
      const terminal: Terminal = { type: 'terminal', reason: 'max_turns' }
      options.onTransition?.(terminal)
      return terminal
    }

    // --- Pre-flight: context management ---
    // Apply tiered decay (full → summary → stub) to old tool results
    if (options.contextManager) {
      const { messages: decayed, actions } = await options.contextManager.applyDecay(state.messages, state.turnCount, options.signal)
      state.messages = decayed
      for (const action of actions) {
        options.onContextAction?.({ type: action.type, tokensSaved: action.tokensSaved })
      }
    }

    // Check if compaction is needed (context too large)
    if (options.compactionStrategy?.shouldCompact(state.messages)) {
      const { messages: compacted, tokensSaved } = await options.compactionStrategy.compact(state.messages)
      if (tokensSaved > 0) {
        state.messages = compacted
        options.onContextAction?.({ type: 'compact', tokensSaved })
        const cont: Continue = { type: 'continue', reason: 'compact_retry' }
        options.onTransition?.(cont)
        state.transition = cont
        continue
      }
    }

    // --- Route to model ---
    const decision = await options.router.route(state.messages, options.purpose)
    const client = options.router.getClient(decision.provider)
    options.onRoute?.({ provider: decision.provider, reason: decision.reason })

    // --- Stream from model ---
    const maxTokens = state.maxTokensOverride ?? DEFAULT_MAX_TOKENS
    let assistantMessage: Message | undefined
    let stopReason: StreamEvent extends { type: 'message_complete' } ? StreamEvent['stopReason'] : string = 'end_turn'
    let turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const toolUseBlocks: ToolUseBlock[] = []

    try {
      const stream = client.stream({
        model: decision.model,
        systemPrompt: options.systemPrompt,
        messages: state.messages,
        tools: options.tools,
        maxTokens,
        signal: options.signal,
      })

      for await (const event of stream) {
        yield event
        options.onEvent?.(event)

        if (event.type === 'tool_use_complete') {
          toolUseBlocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
        }

        if (event.type === 'message_complete') {
          assistantMessage = { ...event.message, turn: state.turnCount }
          stopReason = event.stopReason
          turnUsage = event.usage
        }
      }
    } catch (error) {
      const terminal: Terminal = { type: 'terminal', reason: 'error', error }
      options.onTransition?.(terminal)
      return terminal
    }

    // --- Update total usage ---
    state.totalUsage.inputTokens += turnUsage.inputTokens
    state.totalUsage.outputTokens += turnUsage.outputTokens
    state.totalUsage.cacheReadTokens += turnUsage.cacheReadTokens
    state.totalUsage.cacheCreationTokens += turnUsage.cacheCreationTokens

    // --- Add assistant message to history ---
    if (assistantMessage) {
      state.messages = [...state.messages, assistantMessage]
    }

    // --- Handle stop reason ---

    // max_tokens: escalate or recover (Claude Code pattern)
    if (stopReason === 'max_tokens') {
      if (!state.maxTokensOverride) {
        // First hit: escalate from 8K to 64K
        state.maxTokensOverride = ESCALATED_MAX_TOKENS
        state.turnCount++
        const cont: Continue = { type: 'continue', reason: 'max_tokens_escalation' }
        options.onTransition?.(cont)
        state.transition = cont
        continue
      }

      if (state.recoveryCount < MAX_RECOVERY_ATTEMPTS) {
        // Inject resume message
        state.messages = [...state.messages, {
          role: 'user',
          content: [{ type: 'text', text: 'Output token limit hit. Resume directly — no apology, no recap, just continue exactly where you left off.' }],
          turn: state.turnCount,
        }]
        state.recoveryCount++
        state.turnCount++
        const cont: Continue = { type: 'continue', reason: 'max_tokens_recovery' }
        options.onTransition?.(cont)
        state.transition = cont
        continue
      }

      // Give up after MAX_RECOVERY_ATTEMPTS
      const terminal: Terminal = { type: 'terminal', reason: 'error', error: new Error('Exceeded max_tokens recovery attempts') }
      options.onTransition?.(terminal)
      return terminal
    }

    // tool_use: execute tools and continue
    if (stopReason === 'tool_use' && toolUseBlocks.length > 0) {
      const toolResults: ContentBlock[] = []

      if (options.toolRegistry) {
        // Use StreamingToolExecutor for concurrent read-only / serial write execution
        const executor = createStreamingToolExecutor(options.toolRegistry, options.signal)
        for (const toolUse of toolUseBlocks) {
          executor.addTool(toolUse)
        }
        for await (const completed of executor.drain()) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: completed.toolUse.id,
            content: completed.result.content,
            is_error: completed.result.isError,
          })
        }
      } else {
        // Fallback: simple serial execution
        for (const toolUse of toolUseBlocks) {
          try {
            const result = await options.toolExecutor.execute(toolUse, options.signal)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result.content,
              is_error: result.isError,
            })
          } catch (error) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            })
          }
        }
      }

      // Add tool results as a user message
      state.messages = [...state.messages, {
        role: 'user',
        content: toolResults,
        turn: state.turnCount,
      }]

      state.turnCount++
      state.recoveryCount = 0
      state.maxTokensOverride = undefined
      const cont: Continue = { type: 'continue', reason: 'tool_use' }
      options.onTransition?.(cont)
      state.transition = cont
      if (options.onTurnComplete) {
        await options.onTurnComplete(createTurnSnapshot(state, toolUseBlocks, cont))
      }
      continue
    }

    // end_turn: we're done
    const terminal: Terminal = { type: 'terminal', reason: 'completed' }
    options.onTransition?.(terminal)
    if (options.onTurnComplete) {
      await options.onTurnComplete(createTurnSnapshot(state, [], terminal))
    }
    return terminal
  }
}
