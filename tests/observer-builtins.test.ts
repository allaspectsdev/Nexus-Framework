import { describe, test, expect } from 'bun:test'
import { createSafetyObserver } from '../src/observer/builtins/SafetyObserver.js'
import { createMemoryObserver } from '../src/observer/builtins/MemoryObserver.js'
import { createCostObserver } from '../src/observer/builtins/CostObserver.js'
import type { TurnSnapshot, ObserverContext, Memory, MemoryEntry } from '../src/observer/types.js'

function makeSnapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Analyze the project' }], turn: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'The project uses TypeScript with Bun runtime. It has a modular architecture with separate routing, context, and agent layers.' }], turn: 0 },
    ],
    turnCount: 2,
    totalUsage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    transition: { type: 'continue', reason: 'tool_use' },
    toolUseBlocks: [],
    lastAssistantText: 'The project uses TypeScript with Bun runtime. It has a modular architecture with separate routing, context, and agent layers.',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeContext(inferResponse = 'CLEAR', memories: Memory[] = []): ObserverContext {
  const writtenMemories: MemoryEntry[] = []
  return {
    signal: new AbortController().signal,
    async getMemories() { return memories },
    async writeMemory(entry) { writtenMemories.push(entry) },
    async infer() { return inferResponse },
    // Expose for testing
    get _writtenMemories() { return writtenMemories },
  } as ObserverContext & { _writtenMemories: MemoryEntry[] }
}

describe('SafetyObserver', () => {
  const observer = createSafetyObserver()

  test('has correct metadata', () => {
    expect(observer.name).toBe('safety')
    expect(observer.trigger).toBe('every_turn')
    expect(observer.blocking).toBe(true)
    expect(observer.priority).toBe(10)
  })

  test('returns no actions when response is clear', async () => {
    const ctx = makeContext('CLEAR')
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions).toHaveLength(0)
  })

  test('returns log actions when issues found', async () => {
    const ctx = makeContext('[ISSUE] The response claims file exists at /nonexistent/path\n[ISSUE] Security: API key exposed in output')
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions).toHaveLength(2)
    expect(result.actions[0]!.type).toBe('log')
    expect((result.actions[0] as { severity: string }).severity).toBe('warning')
    expect((result.actions[1] as { severity: string }).severity).toBe('critical') // contains 'security'
  })

  test('skips short responses', async () => {
    const ctx = makeContext('should not be called')
    const result = await observer.run(makeSnapshot({ lastAssistantText: 'OK' }), ctx)
    expect(result.actions).toHaveLength(0)
  })
})

describe('MemoryObserver', () => {
  const observer = createMemoryObserver()

  test('has correct metadata', () => {
    expect(observer.name).toBe('memory')
    expect(observer.trigger).toBe('every_turn')
    expect(observer.blocking).toBe(false)
    expect(observer.priority).toBe(50)
  })

  test('skips early turns', async () => {
    const ctx = makeContext('should not be called')
    const result = await observer.run(makeSnapshot({ turnCount: 1 }), ctx)
    expect(result.actions).toHaveLength(0)
  })

  test('skips short responses', async () => {
    const ctx = makeContext('should not be called')
    const result = await observer.run(makeSnapshot({ turnCount: 3, lastAssistantText: 'OK' }), ctx)
    expect(result.actions).toHaveLength(0)
  })

  test('returns no actions when NONE', async () => {
    const ctx = makeContext('NONE')
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions).toHaveLength(0)
  })

  test('returns memory_write actions for valid JSON', async () => {
    const ctx = makeContext('{"content": "User prefers TypeScript", "type": "preference", "tags": ["lang"]}\n{"content": "Project uses Bun", "type": "fact"}')
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions).toHaveLength(2)
    expect(result.actions[0]!.type).toBe('memory_write')
    const mem = (result.actions[0] as { memory: MemoryEntry }).memory
    expect(mem.content).toBe('User prefers TypeScript')
    expect(mem.type).toBe('preference')
    expect(mem.tags).toEqual(['lang'])
  })

  test('limits to 3 memories per turn', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      `{"content": "fact ${i} about the project architecture and design patterns used throughout", "type": "fact"}`
    ).join('\n')
    const ctx = makeContext(lines)
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions.length).toBeLessThanOrEqual(3)
  })

  test('skips malformed JSON lines', async () => {
    const ctx = makeContext('not json\n{"content": "valid", "type": "fact"}\n{broken')
    const result = await observer.run(makeSnapshot(), ctx)
    expect(result.actions).toHaveLength(1)
  })
})

describe('CostObserver', () => {
  const observer = createCostObserver()

  test('has correct metadata', () => {
    expect(observer.name).toBe('cost')
    expect(observer.trigger).toBe('every_turn')
    expect(observer.blocking).toBe(false)
    expect(observer.priority).toBe(20)
  })

  test('emits tokens_per_turn metric', async () => {
    const ctx = makeContext()
    const result = await observer.run(makeSnapshot(), ctx)
    const metric = result.actions.find(a => a.type === 'metric' && a.name === 'tokens_per_turn')
    expect(metric).toBeDefined()
  })

  test('detects repeated tool calls', async () => {
    const toolUse = { type: 'tool_use' as const, id: 't1', name: 'Grep', input: { pattern: 'foo' } }
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: 'assistant' as const,
      content: [toolUse],
      turn: i,
    }))
    const ctx = makeContext()
    const result = await observer.run(makeSnapshot({ messages, turnCount: 6 }), ctx)
    const warning = result.actions.find(a => a.type === 'log' && a.message.includes('Possible loop'))
    expect(warning).toBeDefined()
  })

  test('detects high token burn rate', async () => {
    const ctx = makeContext()
    const result = await observer.run(makeSnapshot({
      turnCount: 5,
      totalUsage: { inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }), ctx)
    const warning = result.actions.find(a => a.type === 'log' && a.message.includes('High token burn'))
    expect(warning).toBeDefined()
  })

  test('detects repetitive text', async () => {
    const repeated = 'The project structure consists of several modules that handle routing, context management, and agent orchestration in a layered architecture pattern.'
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: repeated }],
      turn: i,
    }))
    const ctx = makeContext()
    const result = await observer.run(makeSnapshot({ messages, turnCount: 5, lastAssistantText: repeated }), ctx)
    const warning = result.actions.find(a => a.type === 'log' && a.message.includes('repeating'))
    expect(warning).toBeDefined()
    const abort = result.actions.find(a => a.type === 'abort_recommendation')
    expect(abort).toBeDefined()
  })

  test('no false positives on normal conversation', async () => {
    const ctx = makeContext()
    const result = await observer.run(makeSnapshot(), ctx)
    const warnings = result.actions.filter(a => a.type === 'log' && (a as { severity: string }).severity === 'warning')
    expect(warnings).toHaveLength(0)
  })
})
