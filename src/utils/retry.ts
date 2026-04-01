/**
 * Retry wrapper for async generator functions with exponential backoff.
 * Retries on transient errors (network, 429, 500, 502, 503, 529).
 */

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529])
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 15000

export type RetryOptions = {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    // Network errors
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('timeout')) {
      return true
    }
    // HTTP status code errors (from Anthropic SDK or fetch)
    for (const code of RETRYABLE_STATUS_CODES) {
      if (msg.includes(String(code))) return true
    }
    // Anthropic SDK rate limit errors
    if (msg.includes('rate_limit') || msg.includes('overloaded')) return true
  }
  return false
}

function delayWithJitter(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt)
  const jitter = exponential * (0.5 + Math.random() * 0.5)
  return Math.min(jitter, maxMs)
}

/**
 * Wrap an async generator factory with retry logic.
 * If the generator throws a retryable error before yielding any value,
 * the entire call is retried. Once the first value is yielded, no retries
 * are attempted (partial streams are not retried to avoid duplicate output).
 */
export async function* withRetry<T, TReturn>(
  factory: () => AsyncGenerator<T, TReturn>,
  options: RetryOptions = {},
): AsyncGenerator<T, TReturn> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Aborted')
    }

    let hasYielded = false
    try {
      const gen = factory()

      // Once we yield the first value, we commit to this attempt
      let result = await gen.next()
      while (!result.done) {
        hasYielded = true
        yield result.value
        result = await gen.next()
      }
      return result.value
    } catch (error) {
      lastError = error

      // Only retry if we haven't yielded anything yet (no partial output)
      // and the error is retryable and we have attempts left
      if (!hasYielded && attempt < maxRetries && isRetryable(error)) {
        const delay = delayWithJitter(attempt, baseDelay, maxDelay)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      throw error
    }
  }

  throw lastError
}
