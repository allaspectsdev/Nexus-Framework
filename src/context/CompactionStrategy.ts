import type { Message, ContentBlock } from '../engine/types.js'
import type { ModelClient } from '../routing/types.js'
import type { NexusConfig } from '../config.js'
import { estimateTokens, estimateMessageTokens } from '../utils/tokens.js'

const MAX_CONTEXT_TOKENS = 150_000
const COMPACT_THRESHOLD = 0.8 // Compact when context reaches 80% of max
const SUMMARY_MARKER = '[Context Summary — earlier conversation compacted]'

/**
 * Incremental compaction strategy.
 * Instead of summarizing the entire history (Claude Code's 187K-token compaction call),
 * we compact in small chunks using the local model — dramatically cheaper.
 */
export function createCompactionStrategy(
  config: NexusConfig,
  localClient?: ModelClient,
) {
  return {
    shouldCompact(messages: Message[]): boolean {
      const tokens = estimateMessageTokens(messages)
      return tokens > MAX_CONTEXT_TOKENS * COMPACT_THRESHOLD
    },

    /**
     * Incrementally compact: summarize the oldest N messages into a single summary,
     * keeping recent messages verbatim. Uses the local model (free).
     */
    async compact(messages: Message[]): Promise<{
      messages: Message[]
      tokensSaved: number
    }> {
      const totalTokens = estimateMessageTokens(messages)
      if (totalTokens <= MAX_CONTEXT_TOKENS * 0.5) {
        return { messages, tokensSaved: 0 }
      }

      // Keep the most recent 10 messages verbatim
      const keepCount = Math.min(10, messages.length)
      let toCompact = messages.slice(0, messages.length - keepCount)
      const toKeep = messages.slice(messages.length - keepCount)

      // Skip already-compacted summary messages to avoid re-summarizing summaries
      toCompact = toCompact.filter(m => {
        if (m.role !== 'user' || m.content.length !== 1) return true
        const block = m.content[0]
        return !(block?.type === 'text' && block.text.startsWith(SUMMARY_MARKER))
      })

      if (toCompact.length === 0) {
        return { messages, tokensSaved: 0 }
      }

      // Build a summary of the older messages
      const summaryText = await generateSummary(toCompact, localClient, config)
      const originalTokens = estimateMessageTokens(toCompact)
      const summaryTokens = estimateTokens(summaryText)

      const compactedMessages: Message[] = [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `${SUMMARY_MARKER}\n\n${summaryText}`,
          }],
          turn: 0,
        },
        ...toKeep,
      ]

      return {
        messages: compactedMessages,
        tokensSaved: originalTokens - summaryTokens,
      }
    },
  }
}

async function generateSummary(
  messages: Message[],
  localClient: ModelClient | undefined,
  config: NexusConfig,
): Promise<string> {
  // Build a condensed representation of the messages
  const parts: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant'
    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push(`${role}: ${block.text.slice(0, 500)}`)
      } else if (block.type === 'tool_use') {
        parts.push(`Assistant called ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`)
      } else if (block.type === 'tool_result') {
        parts.push(`Tool result: ${block.content.slice(0, 200)}`)
      }
    }
  }

  const transcript = parts.join('\n')

  if (!localClient || !(await localClient.isAvailable())) {
    // Fallback: extractive summary (take first 2000 chars)
    return transcript.slice(0, 2000)
  }

  const prompt = `Summarize this conversation transcript concisely. Focus on:
1. What the user asked for
2. Key decisions and findings
3. Files that were read or modified
4. Current task state

Transcript:
${transcript.slice(0, 10000)}

Write a concise summary (max 500 words):`

  let summary = ''
  const stream = localClient.stream({
    model: config.exoModel,
    systemPrompt: 'You are a precise conversation summarizer. Output only the summary.',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], turn: 0 }],
    tools: [],
    maxTokens: 1000,
  })

  for await (const event of stream) {
    if (event.type === 'text_delta') summary += event.text
  }

  return summary.trim() || transcript.slice(0, 2000)
}

export type CompactionStrategy = ReturnType<typeof createCompactionStrategy>
