import type { Observer, ObserverAction } from '../types.js'
import { formatRecentMessages } from '../utils.js'

/**
 * Proactive memory observer — decides what's worth remembering from the conversation.
 * Fire-and-forget: writes memories silently in the background.
 * The primary model never knows this is happening — memories appear in future conversations.
 */
export function createMemoryObserver(): Observer {
  return {
    name: 'memory',
    trigger: 'every_turn',
    blocking: false,
    priority: 50,

    async run(snapshot, ctx) {
      // Skip early turns — not enough context yet
      if (snapshot.turnCount < 2) return { actions: [] }

      // Skip turns with no substantial content
      if (snapshot.lastAssistantText.length < 100) return { actions: [] }

      const existingMemories = await ctx.getMemories()
      const existingSummary = existingMemories.length > 0
        ? `\nExisting memories (do NOT duplicate these):\n${existingMemories.slice(-20).map(m => `- [${m.type}] ${m.content}`).join('\n')}`
        : ''

      const prompt = `Analyze this conversation turn and decide if anything is worth remembering for future conversations.

Worth remembering: user preferences, project-specific facts, corrections the user made, recurring patterns, architectural decisions, user's role/expertise.
NOT worth remembering: transient task details, single-use instructions, obvious facts, information already in the code.
${existingSummary}

Recent conversation:
${formatRecentMessages(snapshot.messages, 5)}

If something is worth remembering, respond with one JSON object per line:
{"content": "the fact to remember", "type": "fact|preference|context|correction|pattern", "tags": ["optional", "tags"]}

If nothing is worth remembering, respond with only "NONE". Be highly selective.`

      const analysis = await ctx.infer(
        prompt,
        'You decide what to remember from conversations. Be highly selective — only genuinely useful facts. Output JSON lines or NONE.',
      )

      const actions: ObserverAction[] = []

      if (!analysis.includes('NONE')) {
        const lines = analysis.split('\n').filter(l => l.trim().startsWith('{'))
        for (const line of lines.slice(0, 3)) { // Max 3 memories per turn
          try {
            const parsed = JSON.parse(line)
            if (parsed.content && parsed.type) {
              actions.push({
                type: 'memory_write',
                memory: {
                  content: String(parsed.content).slice(0, 500),
                  type: parsed.type,
                  tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
                },
              })
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      return { actions, analysis }
    },
  }
}
