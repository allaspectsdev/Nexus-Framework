import { describe, test, expect } from 'bun:test'
import { createRouter } from '../src/routing/Router.js'
import type { NexusConfig } from '../src/config.js'
import type { ModelClient } from '../src/routing/types.js'
import type { Message } from '../src/engine/types.js'

const testConfig: NexusConfig = {
  anthropicApiKey: 'test',
  claudeModel: 'claude-sonnet-4-6-20250514',
  exoEndpoint: 'http://localhost:1234/v1',
  exoModel: 'llama-3.3-70b',
  dashboardPort: 3456,
  routingComplexityThreshold: 0.6,
  contextDecayFullTurns: 2,
  contextDecaySummaryTurns: 5,
  maxConcurrentAgents: 4,
}

function makeMockClient(provider: 'local' | 'claude', available: boolean): ModelClient {
  return {
    provider,
    async *stream() { /* noop */ },
    async isAvailable() { return available },
  }
}

function makeMessages(text: string): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text }], turn: 0 }]
}

describe('Router', () => {
  test('routes to Claude for reasoning tasks', async () => {
    const router = createRouter({
      config: testConfig,
      localClient: makeMockClient('local', true),
      claudeClient: makeMockClient('claude', true),
    })

    const decision = await router.route(makeMessages('hello'), 'reason')
    expect(decision.provider).toBe('claude')
    expect(decision.model).toBe('claude-sonnet-4-6-20250514')
  })

  test('routes to local for summarize tasks when available', async () => {
    const router = createRouter({
      config: testConfig,
      localClient: makeMockClient('local', true),
      claudeClient: makeMockClient('claude', true),
    })

    const decision = await router.route(makeMessages('summarize this'), 'summarize')
    expect(decision.provider).toBe('local')
    expect(decision.model).toBe('llama-3.3-70b')
  })

  test('falls back to Claude when local unavailable', async () => {
    const router = createRouter({
      config: testConfig,
      localClient: makeMockClient('local', false),
      claudeClient: makeMockClient('claude', true),
    })

    const decision = await router.route(makeMessages('summarize this'), 'summarize')
    // Local unavailable, so even summarize falls through to Claude
    expect(decision.provider).toBe('claude')
  })

  test('routes complex tasks to Claude', async () => {
    const router = createRouter({
      config: testConfig,
      localClient: makeMockClient('local', true),
      claudeClient: makeMockClient('claude', true),
    })

    const decision = await router.route(makeMessages('implement a new authentication system'))
    expect(decision.provider).toBe('claude')
    expect(decision.reason).toContain('complexity')
  })

  test('routes simple tasks to local when available', async () => {
    const router = createRouter({
      config: testConfig,
      localClient: makeMockClient('local', true),
      claudeClient: makeMockClient('claude', true),
    })

    const decision = await router.route(makeMessages('list the files in src'))
    expect(decision.provider).toBe('local')
    expect(decision.reason).toContain('complexity')
  })

  test('getClient returns correct client', () => {
    const local = makeMockClient('local', true)
    const claude = makeMockClient('claude', true)
    const router = createRouter({ config: testConfig, localClient: local, claudeClient: claude })

    expect(router.getClient('local')).toBe(local)
    expect(router.getClient('claude')).toBe(claude)
  })
})
