import type { Message, TokenUsage, ToolUseBlock } from '../engine/types.js'
import type { Transition } from '../engine/transitions.js'

// --- TurnSnapshot: frozen read-only state at turn boundary ---

export type TurnSnapshot = {
  readonly messages: readonly Message[]
  readonly turnCount: number
  readonly totalUsage: Readonly<TokenUsage>
  readonly transition: Readonly<Transition>
  readonly toolUseBlocks: readonly ToolUseBlock[]
  readonly lastAssistantText: string
  readonly timestamp: number
}

// --- Observer interface ---

export type ObserverTrigger = 'every_turn' | 'on_complete' | 'on_tool_use' | 'on_error'

export type ObserverSeverity = 'info' | 'warning' | 'critical'

export type ObserverAction =
  | { type: 'log'; message: string; severity: ObserverSeverity }
  | { type: 'memory_write'; memory: MemoryEntry }
  | { type: 'metric'; name: string; value: number }
  | { type: 'abort_recommendation'; reason: string }

export type ObserverResult = {
  actions: ObserverAction[]
  analysis?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export type Observer = {
  name: string
  trigger: ObserverTrigger
  /** If true, query loop waits for this observer before continuing */
  blocking: boolean
  /** Execution priority — lower runs first. Default: 100 */
  priority?: number
  run(snapshot: TurnSnapshot, context: ObserverContext): Promise<ObserverResult>
  destroy?(): void
}

export type ObserverContext = {
  getMemories(): Promise<Memory[]>
  writeMemory(entry: MemoryEntry): Promise<void>
  signal: AbortSignal
  /** Run a cheap inference call (routed to local model by default) */
  infer(prompt: string, systemPrompt?: string): Promise<string>
}

// --- Memory types ---

export type MemoryType = 'fact' | 'preference' | 'context' | 'correction' | 'pattern'

export type MemoryEntry = {
  content: string
  type: MemoryType
  tags?: string[]
  /** Epoch ms when this memory expires (undefined = never) */
  expiresAt?: number
}

export type Memory = MemoryEntry & {
  id: string
  /** Observer name that created this memory */
  source: string
  createdAt: number
  /** How many times this memory has been injected into a system prompt */
  useCount: number
}
