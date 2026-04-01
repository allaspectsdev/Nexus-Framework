import { describe, test, expect } from 'bun:test'
import { createContextManager } from '../src/context/ContextManager.js'
import { createCompactionStrategy } from '../src/context/CompactionStrategy.js'
import type { NexusConfig } from '../src/config.js'
import type { Message } from '../src/engine/types.js'

const testConfig: NexusConfig = {
  anthropicApiKey: 'test',
  claudeModel: 'test',
  exoEndpoint: 'http://localhost:1234/v1',
  exoModel: 'test',
  dashboardPort: 3456,
  routingComplexityThreshold: 0.6,
  contextDecayFullTurns: 2,
  contextDecaySummaryTurns: 5,
  maxConcurrentAgents: 4,
}

function makeToolResultMessage(turn: number, toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
    turn,
  }
}

describe('ContextManager', () => {
  test('keeps recent tool results at full tier', async () => {
    const cm = createContextManager({ config: testConfig })
    const messages: Message[] = [
      makeToolResultMessage(0, 'tool_1', 'Result content here'),
    ]

    // Current turn is 1, decay threshold is 2 — age 1 <= 2, so full
    const { messages: decayed, actions } = await cm.applyDecay(messages, 1)
    expect(decayed).toHaveLength(1)
    expect(decayed[0]!.content[0]!.type).toBe('tool_result')
    expect((decayed[0]!.content[0] as { content: string }).content).toBe('Result content here')
    expect(actions).toHaveLength(0)
  })

  test('decays old tool results to stub', async () => {
    const cm = createContextManager({ config: testConfig })
    // Content must be long enough that the stub saves tokens
    const longContent = 'Line of output from tool execution.\n'.repeat(50)
    const messages: Message[] = [
      makeToolResultMessage(0, 'tool_1', longContent),
    ]

    // Current turn is 10, decay summary threshold is 5 — age 10 > 5, so stub
    const { messages: decayed, actions } = await cm.applyDecay(messages, 10)
    expect(decayed).toHaveLength(1)
    const content = (decayed[0]!.content[0] as { content: string }).content
    expect(content).toContain('[Tool result cleared')
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('decay_to_stub')
  })

  test('decays medium-age results to summary (fallback)', async () => {
    const cm = createContextManager({ config: testConfig })
    // Content must be long enough that the summary saves tokens
    const longContent = 'Detailed file listing output with many entries.\n'.repeat(50)
    const messages: Message[] = [
      // Need a preceding assistant message with tool_use for lookup
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } }],
        turn: 0,
      },
      makeToolResultMessage(0, 'tool_1', longContent),
    ]

    // Current turn is 4, full threshold 2, summary threshold 5 — age 4, 2 < 4 <= 5 → summary
    // No local client → falls back to truncation (first 200 chars)
    const { messages: decayed, actions } = await cm.applyDecay(messages, 4)
    expect(decayed).toHaveLength(2)
    const content = (decayed[1]!.content[0] as { content: string }).content
    expect(content).toContain('[Summary]')
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('decay_to_summary')
  })

  test('passes non-tool messages through unchanged', async () => {
    const cm = createContextManager({ config: testConfig })
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], turn: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], turn: 0 },
    ]

    const { messages: decayed, actions } = await cm.applyDecay(messages, 10)
    expect(decayed).toEqual(messages)
    expect(actions).toHaveLength(0)
  })

  test('respects abort signal', async () => {
    const cm = createContextManager({ config: testConfig })
    const messages: Message[] = [
      makeToolResultMessage(0, 'tool_1', 'content'),
    ]

    const abortController = new AbortController()
    abortController.abort('test abort')

    // Should still work (fallback path doesn't need signal)
    const { messages: decayed } = await cm.applyDecay(messages, 10, abortController.signal)
    expect(decayed).toHaveLength(1)
  })
})

describe('CompactionStrategy', () => {
  test('shouldCompact returns false for small context', () => {
    const strategy = createCompactionStrategy(testConfig)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], turn: 0 },
    ]
    expect(strategy.shouldCompact(messages)).toBe(false)
  })

  test('shouldCompact returns true for large context', () => {
    const strategy = createCompactionStrategy(testConfig)
    // Create messages that exceed 80% of 150K tokens (120K tokens ≈ 480K chars)
    const bigText = 'x'.repeat(500_000)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: bigText }], turn: 0 },
    ]
    expect(strategy.shouldCompact(messages)).toBe(true)
  })

  test('compact keeps recent messages verbatim', async () => {
    const strategy = createCompactionStrategy(testConfig)
    const bigText = 'x'.repeat(500_000)

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: bigText }], turn: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `Message ${i + 1}` }],
        turn: i + 1,
      })),
    ]

    const { messages: compacted, tokensSaved } = await strategy.compact(messages)
    expect(tokensSaved).toBeGreaterThan(0)
    // First message should be the context summary
    expect((compacted[0]!.content[0] as { text: string }).text).toContain('[Context Summary')
    // Last 10 should be preserved
    expect(compacted).toHaveLength(11) // 1 summary + 10 kept
  })

  test('compact skips already-compacted summary messages', async () => {
    const strategy = createCompactionStrategy(testConfig)
    const bigText = 'x'.repeat(500_000)

    // First compaction
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: bigText }], turn: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `Msg ${i}` }],
        turn: i + 1,
      })),
    ]

    const { messages: first } = await strategy.compact(messages)

    // Add more messages to trigger second compaction
    const extended = [
      ...first,
      ...Array.from({ length: 5 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'x'.repeat(50_000) }],
        turn: i + 12,
      })),
    ]

    const { messages: second } = await strategy.compact(extended)
    // The summary message from first compaction should not be re-summarized
    // The result should still have a context summary as first message
    const firstContent = (second[0]!.content[0] as { text: string }).text
    expect(firstContent).toContain('[Context Summary')
  })
})
