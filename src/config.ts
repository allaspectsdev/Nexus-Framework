export type NexusConfig = {
  anthropicApiKey: string
  claudeModel: string
  exoEndpoint: string
  exoModel: string
  dashboardPort: number
  routingComplexityThreshold: number
  contextDecayFullTurns: number
  contextDecaySummaryTurns: number
  maxConcurrentAgents: number
}

export function loadConfig(): NexusConfig {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required. Copy .env.example to .env and fill it in.')
  }

  return {
    anthropicApiKey: key,
    claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
    exoEndpoint: process.env.EXO_ENDPOINT ?? 'http://localhost:52415/v1',
    exoModel: process.env.EXO_MODEL ?? 'llama-3.3-70b',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT ?? '3456', 10),
    routingComplexityThreshold: parseFloat(process.env.ROUTING_COMPLEXITY_THRESHOLD ?? '0.6'),
    contextDecayFullTurns: parseInt(process.env.CONTEXT_DECAY_FULL_TURNS ?? '2', 10),
    contextDecaySummaryTurns: parseInt(process.env.CONTEXT_DECAY_SUMMARY_TURNS ?? '5', 10),
    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '4', 10),
  }
}
