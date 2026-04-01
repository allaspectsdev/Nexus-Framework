import type { Message, ToolSchema } from '../engine/types.js'

/**
 * CacheSafeParams — the contract for prompt cache sharing between parent and child agents.
 * Pattern from Claude Code's forkedAgent.ts lines 47-68.
 *
 * For a child agent to get cache hits off the parent's prefix, these fields
 * must be byte-identical in the API request.
 */
export type CacheSafeParams = {
  systemPrompt: string
  tools: ToolSchema[]
  model: string
  /** Messages up to (not including) the fork point */
  messagePrefix: Message[]
  thinkingConfig: { type: string; budget_tokens?: number }
}

/**
 * Build cache-safe params from the current state.
 * Used when spawning sub-agents to share the parent's prompt cache.
 */
export function buildCacheSafeParams(
  systemPrompt: string,
  tools: ToolSchema[],
  model: string,
  messages: Message[],
  thinkingConfig: { type: string; budget_tokens?: number },
): CacheSafeParams {
  return {
    systemPrompt,
    tools,
    model,
    messagePrefix: [...messages],
    thinkingConfig,
  }
}

/**
 * Build forked messages for multiple children from the same parent state.
 * Pattern from Claude Code's forkSubagent.ts — all children share identical
 * tool_result placeholders so only the final directive differs.
 * This maximizes cache sharing across parallel child agents.
 */
export function buildForkedMessages(
  parentMessages: Message[],
  childDirective: string,
  currentTurn: number,
): Message[] {
  return [
    ...parentMessages,
    {
      role: 'user',
      content: [{ type: 'text', text: childDirective }],
      turn: currentTurn,
    },
  ]
}
