export type MetricEvent =
  | { type: 'token_usage'; provider: 'local' | 'claude'; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
  | { type: 'routing_decision'; provider: string; reason: string; inputTokens: number }
  | { type: 'agent_lifecycle'; agentId: string; name: string; status: string; durationMs?: number }
  | { type: 'tool_execution'; tool: string; durationMs: number; concurrent: boolean; isError: boolean }
  | { type: 'context_decay'; tier: string; tokensSaved: number; messageCount: number }
  | { type: 'compaction'; tokensBefore: number; tokensAfter: number; tokensSaved: number }
  | { type: 'stream_text'; text: string; provider: 'local' | 'claude' }
  | { type: 'observer_log'; observer: string; message: string; severity: 'info' | 'warning' | 'critical' }
  | { type: 'observer_memory'; observer: string; memoryType: string }
  | { type: 'observer_metric'; observer: string; name: string; value: number }

type Listener = (event: MetricEvent) => void

export function createEventBus() {
  const listeners: Set<Listener> = new Set()

  return {
    on(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    emit(event: MetricEvent): void {
      for (const listener of listeners) {
        try { listener(event) } catch {}
      }
    },

    /** Get current listener count (useful for debugging). */
    listenerCount(): number {
      return listeners.size
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
