import type { Message, StreamEvent, ToolSchema, TokenUsage } from '../engine/types.js'

export type ModelProvider = 'local' | 'claude'

export type RoutingDecision = {
  provider: ModelProvider
  model: string
  reason: string
  estimatedInputTokens: number
}

export type ModelCallOptions = {
  model: string
  systemPrompt: string
  messages: Message[]
  tools: ToolSchema[]
  maxTokens: number
  signal?: AbortSignal
}

/**
 * Interface for model clients (Claude API and local exo cluster).
 * Both must produce the same StreamEvent async generator.
 */
export type ModelClient = {
  readonly provider: ModelProvider
  stream(options: ModelCallOptions): AsyncGenerator<StreamEvent>
  isAvailable(): Promise<boolean>
}
