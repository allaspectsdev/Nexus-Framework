import type { NexusConfig } from '../config.js'
import type { Message } from '../engine/types.js'
import type { ModelClient, ModelProvider, RoutingDecision } from './types.js'
import { estimateMessageTokens } from '../utils/tokens.js'

type RouterDeps = {
  config: NexusConfig
  localClient: ModelClient
  claudeClient: ModelClient
}

// Task types that should always go to Claude (need strong reasoning)
const CLAUDE_ONLY_PATTERNS = [
  /\b(implement|refactor|architect|design|debug|fix bug|security|review)\b/i,
  /\b(write.*function|create.*class|build.*component)\b/i,
  /\b(why|explain.*how|what.*cause|root cause)\b/i,
]

// Task types suitable for local models
const LOCAL_PATTERNS = [
  /\b(summarize|summary|list|format|extract|count|find)\b/i,
  /\b(check.*status|what files|which.*directory)\b/i,
  /\b(convert|translate|rewrite.*as)\b/i,
]

function classifyComplexity(messages: Message[]): number {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) return 0.5

  const text = lastUserMsg.content
    .filter(b => b.type === 'text')
    .map(b => b.type === 'text' ? b.text : '')
    .join(' ')

  // Check for Claude-only patterns
  for (const pattern of CLAUDE_ONLY_PATTERNS) {
    if (pattern.test(text)) return 0.9
  }

  // Check for local-friendly patterns
  for (const pattern of LOCAL_PATTERNS) {
    if (pattern.test(text)) return 0.2
  }

  // Heuristic: longer messages tend to be more complex
  const wordCount = text.split(/\s+/).length
  if (wordCount > 200) return 0.8
  if (wordCount > 50) return 0.5
  return 0.3
}

export function createRouter(deps: RouterDeps) {
  let localAvailable: boolean | null = null
  let lastAvailabilityCheck = 0
  const RECHECK_INTERVAL_MS = 30_000 // Re-check local availability every 30s

  return {
    async route(messages: Message[], purpose?: string): Promise<RoutingDecision> {
      // Re-check local availability periodically (detect recovery or failure)
      const now = Date.now()
      if (localAvailable === null || now - lastAvailabilityCheck > RECHECK_INTERVAL_MS) {
        localAvailable = await deps.localClient.isAvailable()
        lastAvailabilityCheck = now
      }

      // Override for specific purposes
      if (purpose === 'summarize' || purpose === 'classify') {
        if (localAvailable) {
          return {
            provider: 'local',
            model: deps.config.exoModel,
            reason: `${purpose} — routed to local model (commodity task)`,
            estimatedInputTokens: estimateMessageTokens(messages),
          }
        }
      }

      if (purpose === 'reason' || purpose === 'generate') {
        return {
          provider: 'claude',
          model: deps.config.claudeModel,
          reason: `${purpose} — routed to Claude (requires strong reasoning)`,
          estimatedInputTokens: estimateMessageTokens(messages),
        }
      }

      // Auto-classify based on message content
      const complexity = classifyComplexity(messages)
      const threshold = deps.config.routingComplexityThreshold

      if (complexity < threshold && localAvailable) {
        return {
          provider: 'local',
          model: deps.config.exoModel,
          reason: `complexity ${complexity.toFixed(2)} < threshold ${threshold} — routed to local`,
          estimatedInputTokens: estimateMessageTokens(messages),
        }
      }

      return {
        provider: 'claude',
        model: deps.config.claudeModel,
        reason: localAvailable
          ? `complexity ${complexity.toFixed(2)} >= threshold ${threshold} — routed to Claude`
          : 'local model unavailable — routed to Claude',
        estimatedInputTokens: estimateMessageTokens(messages),
      }
    },

    getClient(provider: ModelProvider): ModelClient {
      return provider === 'local' ? deps.localClient : deps.claudeClient
    },
  }
}

export type Router = ReturnType<typeof createRouter>
