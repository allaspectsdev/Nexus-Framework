import { describe, test, expect } from 'bun:test'
import { createEventBus, type MetricEvent } from '../src/observability/EventBus.js'

describe('EventBus', () => {
  test('emits events to listeners', () => {
    const bus = createEventBus()
    const received: MetricEvent[] = []
    bus.on((event) => received.push(event))

    const event: MetricEvent = {
      type: 'routing_decision',
      provider: 'claude',
      reason: 'test',
      inputTokens: 100,
    }
    bus.emit(event)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  test('supports multiple listeners', () => {
    const bus = createEventBus()
    let count = 0
    bus.on(() => count++)
    bus.on(() => count++)

    bus.emit({ type: 'routing_decision', provider: 'local', reason: 'test', inputTokens: 0 })
    expect(count).toBe(2)
  })

  test('unsubscribe removes listener', () => {
    const bus = createEventBus()
    let count = 0
    const unsub = bus.on(() => count++)

    bus.emit({ type: 'routing_decision', provider: 'local', reason: 'test', inputTokens: 0 })
    expect(count).toBe(1)

    unsub()
    bus.emit({ type: 'routing_decision', provider: 'local', reason: 'test', inputTokens: 0 })
    expect(count).toBe(1) // not incremented
  })

  test('listenerCount tracks listeners', () => {
    const bus = createEventBus()
    expect(bus.listenerCount()).toBe(0)

    const unsub1 = bus.on(() => {})
    expect(bus.listenerCount()).toBe(1)

    const unsub2 = bus.on(() => {})
    expect(bus.listenerCount()).toBe(2)

    unsub1()
    expect(bus.listenerCount()).toBe(1)

    unsub2()
    expect(bus.listenerCount()).toBe(0)
  })

  test('listener errors do not crash other listeners', () => {
    const bus = createEventBus()
    let secondCalled = false

    bus.on(() => { throw new Error('boom') })
    bus.on(() => { secondCalled = true })

    bus.emit({ type: 'routing_decision', provider: 'local', reason: 'test', inputTokens: 0 })
    expect(secondCalled).toBe(true)
  })
})
