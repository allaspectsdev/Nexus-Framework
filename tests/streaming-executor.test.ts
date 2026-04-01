import { describe, test, expect } from 'bun:test'
import { createStreamingToolExecutor } from '../src/tools/StreamingToolExecutor.js'
import { createToolRegistry } from '../src/tools/ToolRegistry.js'
import { z } from 'zod'
import type { ToolDefinition } from '../src/tools/Tool.js'

function makeReadTool(name: string, result: string, delayMs = 0): ToolDefinition {
  return {
    name,
    description: `Read tool: ${name}`,
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    async call() {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      return { content: result }
    },
  }
}

function makeWriteTool(name: string, result: string, delayMs = 0): ToolDefinition {
  return {
    name,
    description: `Write tool: ${name}`,
    inputSchema: z.object({}),
    isConcurrencySafe: false,
    async call() {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      return { content: result }
    },
  }
}

describe('StreamingToolExecutor', () => {
  test('executes concurrent tools in parallel', async () => {
    const registry = createToolRegistry([
      makeReadTool('ReadA', 'resultA', 50),
      makeReadTool('ReadB', 'resultB', 50),
    ])

    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'a', name: 'ReadA', input: {} })
    executor.addTool({ type: 'tool_use', id: 'b', name: 'ReadB', input: {} })

    const start = performance.now()
    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }
    const elapsed = performance.now() - start

    expect(results).toHaveLength(2)
    // Should run in parallel, not take 100ms+
    expect(elapsed).toBeLessThan(150)
    expect(results.map(r => r.result.content).sort()).toEqual(['resultA', 'resultB'])
  })

  test('executes serial tools one at a time', async () => {
    const registry = createToolRegistry([
      makeWriteTool('WriteA', 'doneA', 10),
      makeWriteTool('WriteB', 'doneB', 10),
    ])

    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'a', name: 'WriteA', input: {} })
    executor.addTool({ type: 'tool_use', id: 'b', name: 'WriteB', input: {} })

    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }

    expect(results).toHaveLength(2)
    expect(results[0]!.result.content).toBe('doneA')
    expect(results[1]!.result.content).toBe('doneB')
    expect(results[0]!.concurrent).toBe(false)
  })

  test('runs concurrent before serial', async () => {
    const registry = createToolRegistry([
      makeReadTool('Read', 'read-result'),
      makeWriteTool('Write', 'write-result'),
    ])

    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'r', name: 'Read', input: {} })
    executor.addTool({ type: 'tool_use', id: 'w', name: 'Write', input: {} })

    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }

    expect(results).toHaveLength(2)
    // Concurrent (read) should come first
    expect(results[0]!.concurrent).toBe(true)
    expect(results[0]!.result.content).toBe('read-result')
    // Serial (write) should come second
    expect(results[1]!.concurrent).toBe(false)
    expect(results[1]!.result.content).toBe('write-result')
  })

  test('handles unknown tools gracefully', async () => {
    const registry = createToolRegistry([])
    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'x', name: 'NonExistent', input: {} })

    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }

    expect(results).toHaveLength(1)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[0]!.result.content).toContain('Unknown tool')
  })

  test('cancel aborts running tools', async () => {
    const registry = createToolRegistry([
      makeReadTool('SlowRead', 'result', 5000),
    ])

    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'slow', name: 'SlowRead', input: {} })

    // Cancel immediately
    executor.cancel()

    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }

    // The tool should have been aborted (or completed with an error)
    // Either way, drain should not hang
    expect(results.length).toBeLessThanOrEqual(1)
  })

  test('serial tools return correct results (no race)', async () => {
    const registry = createToolRegistry([
      makeReadTool('Read1', 'concurrent-result', 10),
      makeWriteTool('Write1', 'serial-1'),
      makeWriteTool('Write2', 'serial-2'),
    ])

    const executor = createStreamingToolExecutor(registry)
    executor.addTool({ type: 'tool_use', id: 'r1', name: 'Read1', input: {} })
    executor.addTool({ type: 'tool_use', id: 'w1', name: 'Write1', input: {} })
    executor.addTool({ type: 'tool_use', id: 'w2', name: 'Write2', input: {} })

    const results = []
    for await (const completed of executor.drain()) {
      results.push(completed)
    }

    expect(results).toHaveLength(3)
    // Serial tools must get their own results, not a stale concurrent result
    expect(results[1]!.result.content).toBe('serial-1')
    expect(results[1]!.toolUse.id).toBe('w1')
    expect(results[2]!.result.content).toBe('serial-2')
    expect(results[2]!.toolUse.id).toBe('w2')
  })
})
