import { describe, test, expect, beforeEach } from 'bun:test'
import { createObserverManager } from '../src/observer/ObserverManager.js'
import { createEventBus } from '../src/observability/EventBus.js'
import { createMemoryStore } from '../src/observer/MemoryStore.js'
import type { Observer, TurnSnapshot, ObserverResult } from '../src/observer/types.js'
import type { ModelClient } from '../src/routing/types.js'
import type { MetricEvent } from '../src/observability/EventBus.js'
import { rmSync } from 'fs'

const TEST_MEM_DIR = '/tmp/nexus-observer-test-' + Date.now()

function mockInferenceClient(): ModelClient {
  return {
    provider: 'local',
    async *stream() {
      yield { type: 'text_delta' as const, text: 'mock response' }
      yield {
        type: 'message_complete' as const,
        message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'mock response' }], turn: 0 },
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
    },
    async isAvailable() { return true },
  }
}

function makeSnapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], turn: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], turn: 0 },
    ],
    turnCount: 1,
    totalUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    transition: { type: 'continue', reason: 'tool_use' },
    toolUseBlocks: [],
    lastAssistantText: 'Hi there!',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeManager() {
  const eventBus = createEventBus()
  const memoryStore = createMemoryStore({ memoryDir: TEST_MEM_DIR, maxEntries: 100, maxPromptEntries: 10 })
  const manager = createObserverManager({
    eventBus,
    memoryStore,
    inferenceClient: mockInferenceClient(),
    inferenceModel: 'test-model',
    observerTimeout: 2000,
  })
  return { manager, eventBus, memoryStore }
}

describe('ObserverManager', () => {
  beforeEach(() => {
    try { rmSync(TEST_MEM_DIR, { recursive: true }) } catch {}
  })

  test('register and list observers', () => {
    const { manager } = makeManager()
    const obs: Observer = {
      name: 'test',
      trigger: 'every_turn',
      blocking: false,
      async run() { return { actions: [] } },
    }
    manager.register(obs)
    expect(manager.getObservers()).toHaveLength(1)
    expect(manager.getObservers()[0]!.name).toBe('test')
  })

  test('unregister removes observer', () => {
    const { manager } = makeManager()
    manager.register({ name: 'a', trigger: 'every_turn', blocking: false, async run() { return { actions: [] } } })
    manager.register({ name: 'b', trigger: 'every_turn', blocking: false, async run() { return { actions: [] } } })
    manager.unregister('a')
    expect(manager.getObservers()).toHaveLength(1)
    expect(manager.getObservers()[0]!.name).toBe('b')
  })

  test('duplicate name replaces observer', () => {
    const { manager } = makeManager()
    manager.register({ name: 'dup', trigger: 'every_turn', blocking: false, async run() { return { actions: [{ type: 'metric', name: 'v', value: 1 }] } } })
    manager.register({ name: 'dup', trigger: 'every_turn', blocking: false, async run() { return { actions: [{ type: 'metric', name: 'v', value: 2 }] } } })
    expect(manager.getObservers()).toHaveLength(1)
  })

  test('blocking observer is awaited', async () => {
    const { manager } = makeManager()
    const order: string[] = []
    manager.register({
      name: 'blocking',
      trigger: 'every_turn',
      blocking: true,
      async run() {
        await new Promise(r => setTimeout(r, 50))
        order.push('blocking')
        return { actions: [] }
      },
    })

    await manager.notify('every_turn', makeSnapshot())
    order.push('after_notify')
    expect(order).toEqual(['blocking', 'after_notify'])
  })

  test('fire-and-forget observer runs in background', async () => {
    const { manager } = makeManager()
    let completed = false
    manager.register({
      name: 'bg',
      trigger: 'every_turn',
      blocking: false,
      async run() {
        await new Promise(r => setTimeout(r, 50))
        completed = true
        return { actions: [] }
      },
    })

    await manager.notify('every_turn', makeSnapshot())
    // Should not be completed yet (fire-and-forget)
    expect(completed).toBe(false)
    expect(manager.getActiveRunCount()).toBe(1)

    // Drain waits for completion
    await manager.drain()
    expect(completed).toBe(true)
    expect(manager.getActiveRunCount()).toBe(0)
  })

  test('observer errors do not crash manager', async () => {
    const { manager, eventBus } = makeManager()
    const logged: MetricEvent[] = []
    eventBus.on(e => logged.push(e))

    manager.register({
      name: 'crasher',
      trigger: 'every_turn',
      blocking: true,
      async run() { throw new Error('boom') },
    })

    // Should not throw
    await manager.notify('every_turn', makeSnapshot())
    expect(logged.some(e => e.type === 'observer_log' && e.message.includes('boom'))).toBe(true)
  })

  test('log action emits to eventBus', async () => {
    const { manager, eventBus } = makeManager()
    const events: MetricEvent[] = []
    eventBus.on(e => events.push(e))

    manager.register({
      name: 'logger',
      trigger: 'every_turn',
      blocking: true,
      async run() {
        return { actions: [{ type: 'log', message: 'found an issue', severity: 'warning' }] }
      },
    })

    await manager.notify('every_turn', makeSnapshot())
    const logEvent = events.find(e => e.type === 'observer_log' && e.message === 'found an issue')
    expect(logEvent).toBeDefined()
  })

  test('memory_write action persists to MemoryStore', async () => {
    const { manager, memoryStore } = makeManager()

    manager.register({
      name: 'mem-writer',
      trigger: 'every_turn',
      blocking: true,
      async run() {
        return { actions: [{ type: 'memory_write', memory: { content: 'user likes dark mode', type: 'preference' } }] }
      },
    })

    await manager.notify('every_turn', makeSnapshot())
    const mems = await memoryStore.getAll()
    expect(mems).toHaveLength(1)
    expect(mems[0]!.content).toBe('user likes dark mode')
    expect(mems[0]!.source).toBe('mem-writer')
  })

  test('priority ordering is respected', async () => {
    const { manager } = makeManager()
    const order: string[] = []

    manager.register({ name: 'last', trigger: 'every_turn', blocking: true, priority: 99, async run() { order.push('last'); return { actions: [] } } })
    manager.register({ name: 'first', trigger: 'every_turn', blocking: true, priority: 1, async run() { order.push('first'); return { actions: [] } } })
    manager.register({ name: 'mid', trigger: 'every_turn', blocking: true, priority: 50, async run() { order.push('mid'); return { actions: [] } } })

    await manager.notify('every_turn', makeSnapshot())
    expect(order).toEqual(['first', 'mid', 'last'])
  })

  test('only triggers matching observers', async () => {
    const { manager } = makeManager()
    let everyTurnRan = false
    let onCompleteRan = false

    manager.register({ name: 'turn', trigger: 'every_turn', blocking: true, async run() { everyTurnRan = true; return { actions: [] } } })
    manager.register({ name: 'done', trigger: 'on_complete', blocking: true, async run() { onCompleteRan = true; return { actions: [] } } })

    await manager.notify('every_turn', makeSnapshot())
    expect(everyTurnRan).toBe(true)
    expect(onCompleteRan).toBe(false)
  })

  test('destroy calls destroy on all observers', () => {
    const { manager } = makeManager()
    let destroyed = false
    manager.register({ name: 'cleanup', trigger: 'every_turn', blocking: false, async run() { return { actions: [] } }, destroy() { destroyed = true } })
    manager.destroy()
    expect(destroyed).toBe(true)
    expect(manager.getObservers()).toHaveLength(0)
  })

  test('infer context calls model client', async () => {
    const { manager } = makeManager()
    let inferResult = ''

    manager.register({
      name: 'inferer',
      trigger: 'every_turn',
      blocking: true,
      async run(snapshot, ctx) {
        inferResult = await ctx.infer('test prompt')
        return { actions: [] }
      },
    })

    await manager.notify('every_turn', makeSnapshot())
    expect(inferResult).toBe('mock response')
  })
})
