import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadConfig, configSchema } from '../src/config.js'

describe('configSchema', () => {
  test('validates correct config', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      dashboardPort: 3456,
      routingComplexityThreshold: 0.6,
      contextDecayFullTurns: 2,
      contextDecaySummaryTurns: 5,
      maxConcurrentAgents: 4,
    })
    expect(result.success).toBe(true)
  })

  test('rejects empty API key', () => {
    const result = configSchema.safeParse({ anthropicApiKey: '' })
    expect(result.success).toBe(false)
  })

  test('rejects out-of-range port', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      dashboardPort: 99999,
    })
    expect(result.success).toBe(false)
  })

  test('rejects threshold > 1', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      routingComplexityThreshold: 5.0,
    })
    expect(result.success).toBe(false)
  })

  test('rejects negative threshold', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      routingComplexityThreshold: -1,
    })
    expect(result.success).toBe(false)
  })

  test('rejects NaN values', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      dashboardPort: NaN,
    })
    expect(result.success).toBe(false)
  })

  test('applies defaults for optional fields', () => {
    const result = configSchema.parse({ anthropicApiKey: 'sk-ant-test' })
    expect(result.dashboardPort).toBe(3456)
    expect(result.routingComplexityThreshold).toBe(0.6)
    expect(result.contextDecayFullTurns).toBe(2)
    expect(result.contextDecaySummaryTurns).toBe(5)
    expect(result.maxConcurrentAgents).toBe(4)
    expect(result.claudeModel).toBe('claude-sonnet-4-6-20250514')
  })

  test('rejects maxConcurrentAgents > 20', () => {
    const result = configSchema.safeParse({
      anthropicApiKey: 'sk-ant-test',
      maxConcurrentAgents: 100,
    })
    expect(result.success).toBe(false)
  })
})

describe('loadConfig', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    // Reset env to a clean state with required key
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    delete process.env.CLAUDE_MODEL
    delete process.env.EXO_ENDPOINT
    delete process.env.DASHBOARD_PORT
    delete process.env.ROUTING_COMPLEXITY_THRESHOLD
    delete process.env.CONTEXT_DECAY_FULL_TURNS
    delete process.env.CONTEXT_DECAY_SUMMARY_TURNS
    delete process.env.MAX_CONCURRENT_AGENTS
  })

  afterEach(() => {
    Object.assign(process.env, origEnv)
  })

  test('loads valid config from env', () => {
    const config = loadConfig()
    expect(config.anthropicApiKey).toBe('sk-ant-test-key')
    expect(config.dashboardPort).toBe(3456)
  })

  test('throws on missing API key', () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(() => loadConfig()).toThrow('Invalid configuration')
  })

  test('throws on invalid port', () => {
    process.env.DASHBOARD_PORT = 'not-a-number'
    expect(() => loadConfig()).toThrow('Invalid configuration')
  })

  test('respects custom values', () => {
    process.env.DASHBOARD_PORT = '8080'
    process.env.ROUTING_COMPLEXITY_THRESHOLD = '0.8'
    const config = loadConfig()
    expect(config.dashboardPort).toBe(8080)
    expect(config.routingComplexityThreshold).toBe(0.8)
  })
})
