import type { Observer, TurnSnapshot, ObserverResult, ObserverContext, ObserverAction, ObserverTrigger, MemoryEntry } from './types.js'
import type { EventBus } from '../observability/EventBus.js'
import type { MemoryStore } from './MemoryStore.js'
import type { ModelClient } from '../routing/types.js'
import { createChildAbort } from '../utils/abort.js'
import { estimateTokens } from '../utils/tokens.js'

export type ObserverManagerDeps = {
  eventBus: EventBus
  memoryStore: MemoryStore
  /** Model client for observer inference (local model by default) */
  inferenceClient: ModelClient
  inferenceModel: string
  parentSignal?: AbortSignal
  /** Timeout for each observer invocation (ms). Default: 10000 */
  observerTimeout?: number
}

export function createObserverManager(deps: ObserverManagerDeps) {
  const observers: Observer[] = []
  const activeRuns = new Set<Promise<void>>()
  const timeout = deps.observerTimeout ?? 10_000

  function buildContext(observer: Observer, signal: AbortSignal): ObserverContext {
    return {
      signal,

      async getMemories() {
        return deps.memoryStore.getAll()
      },

      async writeMemory(entry: MemoryEntry) {
        await deps.memoryStore.write({ ...entry, source: observer.name })
      },

      async infer(prompt: string, systemPrompt?: string): Promise<string> {
        let text = ''
        const stream = deps.inferenceClient.stream({
          model: deps.inferenceModel,
          systemPrompt: systemPrompt ?? 'You are a concise analytical assistant.',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], turn: 0 }],
          tools: [],
          maxTokens: 500,
          signal,
        })

        for await (const event of stream) {
          if (signal.aborted) break
          if (event.type === 'text_delta') text += event.text
        }

        return text.trim()
      },
    }
  }

  async function processActions(observerName: string, actions: ObserverAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case 'log':
          deps.eventBus.emit({
            type: 'observer_log',
            observer: observerName,
            message: action.message,
            severity: action.severity,
          })
          break
        case 'memory_write':
          await deps.memoryStore.write({ ...action.memory, source: observerName })
          deps.eventBus.emit({
            type: 'observer_memory',
            observer: observerName,
            memoryType: action.memory.type,
          })
          break
        case 'metric':
          deps.eventBus.emit({
            type: 'observer_metric',
            observer: observerName,
            name: action.name,
            value: action.value,
          })
          break
        case 'abort_recommendation':
          deps.eventBus.emit({
            type: 'observer_log',
            observer: observerName,
            message: `Abort recommended: ${action.reason}`,
            severity: 'critical',
          })
          break
      }
    }
  }

  async function runObserver(observer: Observer, snapshot: TurnSnapshot): Promise<void> {
    const childAbort = createChildAbort(deps.parentSignal)
    // Compose with timeout
    const timeoutId = setTimeout(() => childAbort.abort('observer_timeout'), timeout)
    const ctx = buildContext(observer, childAbort.signal)

    try {
      const result = await observer.run(snapshot, ctx)
      await processActions(observer.name, result.actions)

      if (result.usage) {
        deps.eventBus.emit({
          type: 'token_usage',
          provider: 'local',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedTokens: 0,
          cost: 0,
        })
      }

      if (result.analysis) {
        deps.eventBus.emit({
          type: 'observer_log',
          observer: observer.name,
          message: result.analysis.slice(0, 200),
          severity: 'info',
        })
      }
    } catch (err) {
      deps.eventBus.emit({
        type: 'observer_log',
        observer: observer.name,
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      })
    } finally {
      clearTimeout(timeoutId)
      if (!childAbort.signal.aborted) childAbort.abort('observer_completed')
    }
  }

  return {
    register(observer: Observer): void {
      // Prevent duplicate names
      const existing = observers.findIndex(o => o.name === observer.name)
      if (existing !== -1) observers.splice(existing, 1)
      observers.push(observer)
      observers.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    },

    unregister(name: string): void {
      const index = observers.findIndex(o => o.name === name)
      if (index !== -1) {
        observers[index]!.destroy?.()
        observers.splice(index, 1)
      }
    },

    /** Run observers matching a trigger against a snapshot. */
    async notify(trigger: ObserverTrigger, snapshot: TurnSnapshot): Promise<void> {
      const matching = observers.filter(o => o.trigger === trigger)
      if (matching.length === 0) return

      const blocking = matching.filter(o => o.blocking)
      const fireAndForget = matching.filter(o => !o.blocking)

      // Run blocking observers sequentially — awaited before returning
      for (const observer of blocking) {
        await runObserver(observer, snapshot)
      }

      // Fire-and-forget observers — tracked for graceful shutdown
      for (const observer of fireAndForget) {
        const promise = runObserver(observer, snapshot).finally(() => {
          activeRuns.delete(promise)
        })
        activeRuns.add(promise)
      }
    },

    /** Wait for all in-flight fire-and-forget observers. */
    async drain(): Promise<void> {
      await Promise.allSettled([...activeRuns])
    },

    /** Destroy all observers and clear state. */
    destroy(): void {
      for (const o of observers) o.destroy?.()
      observers.length = 0
    },

    getObservers(): readonly Observer[] {
      return observers
    },

    getActiveRunCount(): number {
      return activeRuns.size
    },
  }
}

export type ObserverManager = ReturnType<typeof createObserverManager>
