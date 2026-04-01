import type { Message } from '../engine/types.js'

/** Format the last N messages as readable text for observer prompts. */
export function formatRecentMessages(messages: readonly Message[], count: number): string {
  const recent = messages.slice(-count)
  const parts: string[] = []

  for (const msg of recent) {
    const role = msg.role === 'user' ? 'User' : 'Assistant'
    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push(`[${role}]: ${block.text.slice(0, 1000)}`)
      } else if (block.type === 'tool_use') {
        parts.push(`[${role} called ${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`)
      } else if (block.type === 'tool_result') {
        parts.push(`[Tool result]: ${block.content.slice(0, 300)}`)
      }
    }
  }

  return parts.join('\n\n')
}

/** Character trigram similarity (0-1). Used to detect repetitive model output. */
export function trigramSimilarity(a: string, b: string): number {
  if (a.length < 3 || b.length < 3) return a === b ? 1 : 0

  const trigramsA = new Set<string>()
  const trigramsB = new Set<string>()

  for (let i = 0; i <= a.length - 3; i++) trigramsA.add(a.slice(i, i + 3))
  for (let i = 0; i <= b.length - 3; i++) trigramsB.add(b.slice(i, i + 3))

  let intersection = 0
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++
  }

  const union = trigramsA.size + trigramsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Normalized Levenshtein similarity (0-1). Used for memory deduplication. */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  // Truncate for performance — we only need approximate similarity
  const maxLen = 500
  const sa = a.slice(0, maxLen)
  const sb = b.slice(0, maxLen)

  const la = sa.length
  const lb = sb.length
  const matrix: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      )
    }
  }

  const distance = matrix[la]![lb]!
  return 1 - distance / Math.max(la, lb)
}
