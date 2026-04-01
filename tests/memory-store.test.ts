import { describe, test, expect, beforeEach } from 'bun:test'
import { createMemoryStore } from '../src/observer/MemoryStore.js'
import { rmSync } from 'fs'

const TEST_DIR = '/tmp/nexus-test-memory-' + Date.now()

function makeStore(maxEntries = 200, maxPromptEntries = 20) {
  return createMemoryStore({ memoryDir: TEST_DIR, maxEntries, maxPromptEntries })
}

describe('MemoryStore', () => {
  beforeEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }) } catch {}
  })

  test('write and read a memory', async () => {
    const store = makeStore()
    const mem = await store.write({ content: 'User prefers TypeScript', type: 'preference', source: 'test' })
    expect(mem.id).toMatch(/^mem_/)
    expect(mem.content).toBe('User prefers TypeScript')
    expect(mem.source).toBe('test')
    expect(mem.useCount).toBe(0)

    const all = await store.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.content).toBe('User prefers TypeScript')
  })

  test('deduplicates identical content', async () => {
    const store = makeStore()
    await store.write({ content: 'fact A', type: 'fact', source: 'obs' })
    await store.write({ content: 'fact A', type: 'fact', source: 'obs' })
    expect(await store.count()).toBe(1)
  })

  test('deduplicates similar content via Levenshtein', async () => {
    const store = makeStore()
    await store.write({ content: 'User prefers dark theme in VS Code', type: 'preference', source: 'obs' })
    await store.write({ content: 'User prefers dark theme in VSCode', type: 'preference', source: 'obs' })
    expect(await store.count()).toBe(1)
  })

  test('allows different types with same content', async () => {
    const store = makeStore()
    await store.write({ content: 'important thing', type: 'fact', source: 'obs' })
    await store.write({ content: 'important thing', type: 'correction', source: 'obs' })
    // Same content but different type — still deduped by content match
    expect(await store.count()).toBe(1)
  })

  test('delete removes a memory', async () => {
    const store = makeStore()
    const mem = await store.write({ content: 'to delete', type: 'fact', source: 'test' })
    expect(await store.count()).toBe(1)
    const deleted = await store.delete(mem.id)
    expect(deleted).toBe(true)
    expect(await store.count()).toBe(0)
  })

  test('delete returns false for unknown id', async () => {
    const store = makeStore()
    expect(await store.delete('nonexistent')).toBe(false)
  })

  test('evicts lowest-scoring memories when exceeding max', async () => {
    const store = makeStore(3)
    await store.write({ content: 'old memory', type: 'fact', source: 'test' })
    await store.write({ content: 'mid memory', type: 'fact', source: 'test' })
    await store.write({ content: 'new memory', type: 'fact', source: 'test' })
    await store.write({ content: 'newest memory', type: 'fact', source: 'test' })
    expect(await store.count()).toBe(3)
  })

  test('buildPromptBlock returns empty string when no memories', async () => {
    const store = makeStore()
    expect(await store.buildPromptBlock()).toBe('')
  })

  test('buildPromptBlock returns formatted XML block', async () => {
    const store = makeStore()
    await store.write({ content: 'User is a senior engineer', type: 'fact', source: 'test' })
    await store.write({ content: 'Prefers concise output', type: 'preference', tags: ['style'], source: 'test' })

    const block = await store.buildPromptBlock()
    expect(block).toContain('<memories>')
    expect(block).toContain('[fact] User is a senior engineer')
    expect(block).toContain('[preference] Prefers concise output (style)')
    expect(block).toContain('</memories>')
  })

  test('buildPromptBlock increments useCount', async () => {
    const store = makeStore()
    await store.write({ content: 'a fact', type: 'fact', source: 'test' })

    await store.buildPromptBlock()
    const mems = await store.getAll()
    expect(mems[0]!.useCount).toBe(1)

    store.resetCache()
    await store.buildPromptBlock()
    const mems2 = await store.getAll()
    expect(mems2[0]!.useCount).toBe(2)
  })

  test('buildPromptBlock limits to maxPromptEntries', async () => {
    const store = makeStore(100, 2)
    const topics = ['TypeScript generics', 'React hooks pattern', 'PostgreSQL indexing', 'Docker networking', 'GraphQL resolvers', 'Kubernetes pods', 'Redis caching', 'WebSocket protocol', 'OAuth2 flows', 'gRPC services']
    for (const topic of topics) {
      await store.write({ content: `User is experienced with ${topic}`, type: 'fact', source: 'test' })
    }

    const block = await store.buildPromptBlock()
    const lines = block.split('\n').filter(l => l.startsWith('- ['))
    expect(lines.length).toBe(2)
  })

  test('clear removes all memories', async () => {
    const store = makeStore()
    await store.write({ content: 'a', type: 'fact', source: 'test' })
    await store.write({ content: 'b', type: 'fact', source: 'test' })
    await store.clear()
    expect(await store.count()).toBe(0)
  })

  test('persists to disk and survives reload', async () => {
    const store1 = makeStore()
    await store1.write({ content: 'persistent fact', type: 'fact', source: 'test' })

    // Create new store instance pointing to same dir
    const store2 = makeStore()
    const mems = await store2.getAll()
    expect(mems).toHaveLength(1)
    expect(mems[0]!.content).toBe('persistent fact')
  })

  test('prunes expired memories on load', async () => {
    const store = makeStore()
    await store.write({ content: 'expired', type: 'fact', source: 'test', expiresAt: Date.now() - 1000 })
    await store.write({ content: 'valid', type: 'fact', source: 'test' })

    // Force reload
    store.resetCache()
    const mems = await store.getAll()
    expect(mems).toHaveLength(1)
    expect(mems[0]!.content).toBe('valid')
  })

  test('handles tags correctly', async () => {
    const store = makeStore()
    const mem = await store.write({ content: 'tagged', type: 'fact', tags: ['arch', 'ts'], source: 'test' })
    expect(mem.tags).toEqual(['arch', 'ts'])
  })
})
