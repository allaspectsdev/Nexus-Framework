import { describe, test, expect } from 'bun:test'
import { withRetry } from '../src/utils/retry.js'

async function* succeedingGen(): AsyncGenerator<string, string> {
  yield 'a'
  yield 'b'
  return 'done'
}

async function* failingGen(): AsyncGenerator<string, string> {
  throw new Error('fetch failed: connection refused')
}

describe('withRetry', () => {
  test('passes through successful generator', async () => {
    const values: string[] = []
    let returnValue: string | undefined
    const gen = withRetry(() => succeedingGen())
    let result = await gen.next()
    while (!result.done) {
      values.push(result.value)
      result = await gen.next()
    }
    returnValue = result.value
    expect(values).toEqual(['a', 'b'])
    expect(returnValue).toBe('done')
  })

  test('retries on retryable error', async () => {
    let attempts = 0
    async function* flakyGen(): AsyncGenerator<string, string> {
      attempts++
      if (attempts < 3) throw new Error('fetch failed: network error')
      yield 'success'
      return 'done'
    }

    const values: string[] = []
    const gen = withRetry(() => flakyGen(), { baseDelayMs: 10, maxDelayMs: 50 })
    let result = await gen.next()
    while (!result.done) {
      values.push(result.value)
      result = await gen.next()
    }
    expect(attempts).toBe(3)
    expect(values).toEqual(['success'])
  })

  test('does not retry non-retryable errors', async () => {
    let attempts = 0
    async function* badGen(): AsyncGenerator<string, string> {
      attempts++
      throw new Error('Invalid API key')
    }

    const gen = withRetry(() => badGen(), { baseDelayMs: 10 })
    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).toThrow('Invalid API key')
    expect(attempts).toBe(1)
  })

  test('gives up after max retries', async () => {
    let attempts = 0
    async function* alwaysFail(): AsyncGenerator<string, string> {
      attempts++
      throw new Error('fetch failed: timeout')
    }

    const gen = withRetry(() => alwaysFail(), { maxRetries: 2, baseDelayMs: 10 })
    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).toThrow('fetch failed: timeout')
    expect(attempts).toBe(3) // initial + 2 retries
  })

  test('does not retry after first yield', async () => {
    let attempts = 0
    async function* partialThenFail(): AsyncGenerator<string, string> {
      attempts++
      yield 'partial'
      throw new Error('fetch failed: connection reset mid-stream')
    }

    const gen = withRetry(() => partialThenFail(), { baseDelayMs: 10 })
    const first = await gen.next()
    expect(first.value).toBe('partial')
    await expect(gen.next()).rejects.toThrow('connection reset')
    expect(attempts).toBe(1) // no retry since we already yielded
  })

  test('respects abort signal', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')

    const gen = withRetry(() => failingGen(), { signal: controller.signal, baseDelayMs: 10 })
    await expect(gen.next()).rejects.toThrow()
  })

  test('retries on 429 rate limit', async () => {
    let attempts = 0
    async function* rateLimited(): AsyncGenerator<string, string> {
      attempts++
      if (attempts === 1) throw new Error('Error 429: rate_limit_exceeded')
      yield 'ok'
      return 'done'
    }

    const gen = withRetry(() => rateLimited(), { baseDelayMs: 10 })
    const values: string[] = []
    let result = await gen.next()
    while (!result.done) {
      values.push(result.value)
      result = await gen.next()
    }
    expect(attempts).toBe(2)
    expect(values).toEqual(['ok'])
  })

  test('retries on 500 server error', async () => {
    let attempts = 0
    async function* serverError(): AsyncGenerator<string, string> {
      attempts++
      if (attempts === 1) throw new Error('500 Internal Server Error')
      yield 'recovered'
      return 'done'
    }

    const gen = withRetry(() => serverError(), { baseDelayMs: 10 })
    const values: string[] = []
    let result = await gen.next()
    while (!result.done) {
      values.push(result.value)
      result = await gen.next()
    }
    expect(attempts).toBe(2)
    expect(values).toEqual(['recovered'])
  })
})
