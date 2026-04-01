import type { z } from 'zod'

// --- Messages ---

export type Role = 'user' | 'assistant'

export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type ThinkingBlock = { type: 'thinking'; thinking: string }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

export type Message = {
  role: Role
  content: ContentBlock[]
  /** Turn number when this message was created */
  turn: number
  /** Which model provider generated this (for assistant messages) */
  provider?: 'local' | 'claude'
  /** Estimated token count of this message */
  tokenEstimate?: number
}

// --- Streaming ---

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; input: string }
  | { type: 'tool_use_complete'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_complete'; message: Message; stopReason: StopReason; usage: TokenUsage }
  | { type: 'error'; error: unknown }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

// --- Tool Definitions ---

export type ToolSchema = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
