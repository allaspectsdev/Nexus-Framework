const BYTES_PER_TOKEN = 4

/** Rough token count — chars / 4. Consistent with Claude Code's estimator. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN)
}

/** Estimate tokens for a message array (JSON-serialized). */
export function estimateMessageTokens(messages: unknown[]): number {
  return estimateTokens(JSON.stringify(messages))
}

/** Format token count for display: 1234 → "1.2K", 123456 → "123K" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n / 1000)}K`
}
