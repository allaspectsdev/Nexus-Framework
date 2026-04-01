import { z } from 'zod'

export const configSchema = z.object({
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  claudeModel: z.string().default('claude-sonnet-4-6-20250514'),
  exoEndpoint: z.string().url().default('http://localhost:52415/v1'),
  exoModel: z.string().default('llama-3.3-70b'),
  dashboardPort: z.number().int().min(1).max(65535).default(3456),
  routingComplexityThreshold: z.number().min(0).max(1).default(0.6),
  contextDecayFullTurns: z.number().int().min(0).max(50).default(2),
  contextDecaySummaryTurns: z.number().int().min(1).max(100).default(5),
  maxConcurrentAgents: z.number().int().min(1).max(20).default(4),
})

export type NexusConfig = z.infer<typeof configSchema>

export function loadConfig(): NexusConfig {
  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    claudeModel: process.env.CLAUDE_MODEL || undefined,
    exoEndpoint: process.env.EXO_ENDPOINT || undefined,
    exoModel: process.env.EXO_MODEL || undefined,
    dashboardPort: process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT, 10) : undefined,
    routingComplexityThreshold: process.env.ROUTING_COMPLEXITY_THRESHOLD ? parseFloat(process.env.ROUTING_COMPLEXITY_THRESHOLD) : undefined,
    contextDecayFullTurns: process.env.CONTEXT_DECAY_FULL_TURNS ? parseInt(process.env.CONTEXT_DECAY_FULL_TURNS, 10) : undefined,
    contextDecaySummaryTurns: process.env.CONTEXT_DECAY_SUMMARY_TURNS ? parseInt(process.env.CONTEXT_DECAY_SUMMARY_TURNS, 10) : undefined,
    maxConcurrentAgents: process.env.MAX_CONCURRENT_AGENTS ? parseInt(process.env.MAX_CONCURRENT_AGENTS, 10) : undefined,
  }

  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  }

  return result.data
}
