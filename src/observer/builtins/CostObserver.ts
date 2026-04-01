import type { Observer, ObserverAction } from '../types.js'
import { trigramSimilarity } from '../utils.js'

/**
 * Cost/efficiency observer — detects loops, repeated tool calls, and token waste.
 * Zero inference cost: pure heuristics only.
 */
export function createCostObserver(): Observer {
  return {
    name: 'cost',
    trigger: 'every_turn',
    blocking: false,
    priority: 20,

    async run(snapshot) {
      const actions: ObserverAction[] = []

      // --- Detect repeated tool calls ---
      const recentToolUses = snapshot.messages
        .slice(-10)
        .flatMap(m => m.content.filter(b => b.type === 'tool_use'))

      const toolCounts = new Map<string, number>()
      for (const block of recentToolUses) {
        if (block.type === 'tool_use') {
          const key = `${block.name}:${JSON.stringify(block.input).slice(0, 100)}`
          toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1)
        }
      }

      for (const [key, count] of toolCounts) {
        if (count >= 3) {
          actions.push({
            type: 'log',
            message: `Possible loop: "${key.split(':')[0]}" called ${count} times with similar input`,
            severity: 'warning',
          })
        }
      }

      // --- Detect high token burn rate ---
      const totalTokens = snapshot.totalUsage.inputTokens + snapshot.totalUsage.outputTokens
      const tokensPerTurn = totalTokens / Math.max(1, snapshot.turnCount)

      if (tokensPerTurn > 50_000 && snapshot.turnCount > 3) {
        actions.push({
          type: 'log',
          message: `High token burn: ${Math.round(tokensPerTurn)} tokens/turn average`,
          severity: 'warning',
        })
      }

      // Emit tokens-per-turn metric
      actions.push({
        type: 'metric',
        name: 'tokens_per_turn',
        value: Math.round(tokensPerTurn),
      })

      // --- Detect repetitive assistant text ---
      if (snapshot.turnCount >= 4) {
        const recentTexts = snapshot.messages
          .filter(m => m.role === 'assistant')
          .slice(-4)
          .map(m =>
            m.content
              .filter(b => b.type === 'text')
              .map(b => (b.type === 'text' ? b.text : ''))
              .join('')
          )

        if (recentTexts.length >= 2) {
          const last = recentTexts[recentTexts.length - 1]!
          const prev = recentTexts[recentTexts.length - 2]!
          if (last.length > 100 && trigramSimilarity(last, prev) > 0.6) {
            actions.push({
              type: 'log',
              message: 'Model appears to be repeating itself — possible loop detected',
              severity: 'warning',
            })
            actions.push({
              type: 'abort_recommendation',
              reason: 'Detected repetitive output pattern',
            })
          }
        }
      }

      return { actions }
    },
  }
}
