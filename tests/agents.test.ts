import { describe, test, expect } from 'bun:test'
import { createAgentRegistry } from '../src/agents/AgentRegistry.js'
import { formatNotification } from '../src/agents/notifications.js'

describe('AgentRegistry', () => {
  test('register creates agent with pending status', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('test-worker', 'test purpose')
    expect(agent.name).toBe('test-worker')
    expect(agent.status).toBe('pending')
    expect(agent.id).toMatch(/^agent_/)
  })

  test('get retrieves agent by id', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('worker', 'purpose')
    expect(registry.get(agent.id)).toBe(agent)
  })

  test('getByName retrieves agent by name', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('finder', 'purpose')
    expect(registry.getByName('finder')).toBe(agent)
  })

  test('update patches agent state', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('worker', 'purpose')
    registry.update(agent.id, { status: 'running', toolUseCount: 5 })
    expect(agent.status).toBe('running')
    expect(agent.toolUseCount).toBe(5)
  })

  test('kill sets status to killed and aborts controller', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('worker', 'purpose')
    const controller = new AbortController()
    registry.update(agent.id, { status: 'running', controller })

    expect(controller.signal.aborted).toBe(false)
    registry.kill(agent.id)
    expect(agent.status).toBe('killed')
    expect(agent.completedAt).toBeDefined()
    expect(controller.signal.aborted).toBe(true)
  })

  test('kill does nothing for completed agents', () => {
    const registry = createAgentRegistry()
    const agent = registry.register('worker', 'purpose')
    registry.update(agent.id, { status: 'completed' })
    registry.kill(agent.id)
    expect(agent.status).toBe('completed')
  })

  test('getActive returns running and pending agents', () => {
    const registry = createAgentRegistry()
    const a1 = registry.register('w1', 'p')
    const a2 = registry.register('w2', 'p')
    const a3 = registry.register('w3', 'p')
    registry.update(a1.id, { status: 'running' })
    registry.update(a2.id, { status: 'completed' })
    registry.update(a3.id, { status: 'pending' })

    const active = registry.getActive()
    expect(active).toHaveLength(2)
    expect(active.map(a => a.name).sort()).toEqual(['w1', 'w3'])
  })

  test('getAll returns all agents', () => {
    const registry = createAgentRegistry()
    registry.register('a', 'p')
    registry.register('b', 'p')
    registry.register('c', 'p')
    expect(registry.getAll()).toHaveLength(3)
  })
})

describe('formatNotification', () => {
  test('formats a completed notification', () => {
    const xml = formatNotification({
      taskId: 'agent_abc',
      name: 'explorer',
      status: 'completed',
      summary: 'Found 10 files',
      result: 'Detailed results here',
      usage: { totalTokens: 1000, toolUses: 5, durationMs: 3000 },
    })

    expect(xml).toContain('<task-id>agent_abc</task-id>')
    expect(xml).toContain('<name>explorer</name>')
    expect(xml).toContain('<status>completed</status>')
    expect(xml).toContain('<result>Detailed results here</result>')
    expect(xml).toContain('<total-tokens>1000</total-tokens>')
  })

  test('escapes XML special characters', () => {
    const xml = formatNotification({
      taskId: 'id',
      name: '<script>alert</script>',
      status: 'completed',
      summary: 'a & b < c > d',
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    })

    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;script&gt;')
    expect(xml).toContain('a &amp; b &lt; c &gt; d')
  })

  test('omits result when undefined', () => {
    const xml = formatNotification({
      taskId: 'id',
      name: 'worker',
      status: 'failed',
      summary: 'Error occurred',
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    })

    expect(xml).not.toContain('<result>')
  })
})
