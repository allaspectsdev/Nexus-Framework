import type { Observer, ObserverAction } from '../types.js'
import { formatRecentMessages } from '../utils.js'

/**
 * Safety/quality observer — reviews each turn for issues the primary model missed.
 * Blocking: runs before the next turn to surface warnings early.
 */
export function createSafetyObserver(): Observer {
  return {
    name: 'safety',
    trigger: 'every_turn',
    blocking: true,
    priority: 10,

    async run(snapshot, ctx) {
      // Skip short responses — not enough content to review
      if (snapshot.lastAssistantText.length < 50) {
        return { actions: [] }
      }

      const prompt = `Review this AI assistant turn for issues. Check for:
1. Contradictions with earlier messages in the conversation
2. Hallucinated facts or fabricated file paths/URLs
3. Security concerns (exposed secrets, unsafe commands suggested)
4. Confident claims that may be wrong

Conversation context (last 3 messages):
${formatRecentMessages(snapshot.messages, 3)}

Latest assistant response:
${snapshot.lastAssistantText.slice(0, 3000)}

If you find genuine issues, list each on its own line prefixed with [ISSUE]. If no issues found, respond with only "CLEAR". Be strict — only flag real problems, not style preferences.`

      const analysis = await ctx.infer(
        prompt,
        'You are a quality reviewer. Be concise and precise. Only flag genuine concerns.',
      )

      const actions: ObserverAction[] = []

      if (analysis.includes('[ISSUE]')) {
        const issues = analysis.split('\n').filter(l => l.includes('[ISSUE]'))
        for (const issue of issues) {
          const message = issue.replace('[ISSUE]', '').trim()
          actions.push({
            type: 'log',
            message,
            severity: message.toLowerCase().includes('security') ? 'critical' : 'warning',
          })
        }
      }

      return { actions, analysis }
    },
  }
}
