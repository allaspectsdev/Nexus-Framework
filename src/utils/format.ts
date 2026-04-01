/** Format milliseconds as human-readable duration: "1.2s", "45ms", "2m 13s" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

/** Format cost in dollars: 0.00123 → "$0.0012" */
export function formatCost(dollars: number): string {
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  if (dollars < 1) return `$${dollars.toFixed(3)}`
  return `$${dollars.toFixed(2)}`
}

/** Generate a short random ID (cryptographically unique) */
export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}
