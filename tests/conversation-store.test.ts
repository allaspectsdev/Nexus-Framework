import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createConversationStore } from '../src/db/ConversationStore.js'
import { rmSync } from 'fs'

const TEST_DB = '/tmp/nexus-test-conv-' + Date.now() + '.db'

describe('ConversationStore', () => {
  let store: ReturnType<typeof createConversationStore>

  beforeEach(() => {
    store = createConversationStore(TEST_DB)
  })

  afterEach(() => {
    store.close()
    try { rmSync(TEST_DB) } catch {}
    try { rmSync(TEST_DB + '-wal') } catch {}
    try { rmSync(TEST_DB + '-shm') } catch {}
  })

  test('create and get a conversation', () => {
    const conv = store.create('Test conversation', 'single')
    expect(conv.id).toMatch(/^conv_/)
    expect(conv.title).toBe('Test conversation')
    expect(conv.mode).toBe('single')

    const loaded = store.get(conv.id)
    expect(loaded).toBeDefined()
    expect(loaded!.title).toBe('Test conversation')
    expect(loaded!.messages).toHaveLength(0)
  })

  test('list conversations returns all created', () => {
    store.create('First', 'single')
    store.create('Second', 'multi')
    store.create('Third', 'single')

    const list = store.list()
    expect(list).toHaveLength(3)
    const titles = list.map(c => c.title).sort()
    expect(titles).toEqual(['First', 'Second', 'Third'])
  })

  test('add messages and retrieve them', () => {
    const conv = store.create('Chat', 'single')

    store.addMessage(conv.id, {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      turn: 0,
    })

    store.addMessage(conv.id, {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      turn: 0,
      provider: 'claude',
      tokenEstimate: 50,
    })

    const loaded = store.get(conv.id)
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]!.role).toBe('user')
    expect(loaded!.messages[0]!.content[0]!.type).toBe('text')
    expect(loaded!.messages[1]!.role).toBe('assistant')
    expect(loaded!.messages[1]!.provider).toBe('claude')
  })

  test('list includes message count', () => {
    const conv = store.create('Chat', 'single')
    store.addMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'hi' }], turn: 0 })
    store.addMessage(conv.id, { role: 'assistant', content: [{ type: 'text', text: 'hello' }], turn: 0 })

    const list = store.list()
    expect(list[0]!.messageCount).toBe(2)
  })

  test('update title', () => {
    const conv = store.create('Old title', 'single')
    store.updateTitle(conv.id, 'New title')

    const loaded = store.get(conv.id)
    expect(loaded!.title).toBe('New title')
  })

  test('delete conversation and cascade messages', () => {
    const conv = store.create('To delete', 'single')
    store.addMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'hi' }], turn: 0 })

    const deleted = store.delete(conv.id)
    expect(deleted).toBe(true)
    expect(store.get(conv.id)).toBeUndefined()
  })

  test('delete returns false for unknown id', () => {
    expect(store.delete('nonexistent')).toBe(false)
  })

  test('list respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      store.create(`Conv ${i}`, 'single')
    }

    const page1 = store.list(3, 0)
    expect(page1).toHaveLength(3)

    const page2 = store.list(3, 3)
    expect(page2).toHaveLength(3)
    expect(page2[0]!.id).not.toBe(page1[0]!.id)
  })

  test('messages preserve complex content blocks', () => {
    const conv = store.create('Complex', 'single')

    store.addMessage(conv.id, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'tool_1', name: 'ReadFile', input: { file_path: 'test.ts' } },
      ],
      turn: 1,
      provider: 'claude',
    })

    const loaded = store.get(conv.id)
    const msg = loaded!.messages[0]!
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0]!.type).toBe('text')
    expect(msg.content[1]!.type).toBe('tool_use')
    expect((msg.content[1] as { name: string }).name).toBe('ReadFile')
  })
})
