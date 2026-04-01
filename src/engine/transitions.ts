/**
 * Explicit transition types for the query loop state machine.
 * Pattern from Claude Code's query.ts — every loop iteration has
 * a clear reason for why it continued or terminated.
 */

export type Terminal = {
  type: 'terminal'
  reason:
    | 'completed'       // Model said end_turn with no tool calls
    | 'max_turns'       // Hit the turn limit
    | 'aborted'         // AbortSignal fired
    | 'error'           // Unrecoverable error
  error?: unknown
}

export type Continue = {
  type: 'continue'
  reason:
    | 'tool_use'                // Model requested tool calls, need to execute and continue
    | 'max_tokens_escalation'   // Hit max_tokens, retrying with higher limit
    | 'max_tokens_recovery'     // Injecting resume message after max_tokens
    | 'compact_retry'           // Context was compacted, retrying
    | 'next_turn'               // Normal continuation after tool results
}

export type Transition = Terminal | Continue
