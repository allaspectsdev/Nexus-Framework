import type { ContentBlock, Message, StreamEvent } from '../engine/types.js'
import type { ModelClient, ModelCallOptions } from './types.js'
import { estimateTokens } from '../utils/tokens.js'
import { withRetry } from '../utils/retry.js'

type OpenAIMessage = { role: string; content: string }

function toOpenAIMessages(systemPrompt: string, messages: Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }]

  for (const msg of messages) {
    const textParts: string[] = []
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text)
      else if (block.type === 'tool_result') textParts.push(`[Tool Result: ${block.content}]`)
      else if (block.type === 'tool_use') textParts.push(`[Called tool: ${block.name}]`)
    }
    if (textParts.length > 0) {
      result.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: textParts.join('\n') })
    }
  }

  return result
}

async function* streamImpl(endpoint: string, defaultModel: string, options: ModelCallOptions): AsyncGenerator<StreamEvent> {
  const openaiMessages = toOpenAIMessages(options.systemPrompt, options.messages)

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model || defaultModel,
      messages: openaiMessages,
      stream: true,
      max_tokens: options.maxTokens,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    throw new Error(`Local model error: ${response.status} ${response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body from local model')

  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  while (true) {
    if (options.signal?.aborted) {
      reader.cancel()
      break
    }
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          yield { type: 'text_delta', text: delta }
        }
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  const content: ContentBlock[] = fullText ? [{ type: 'text', text: fullText }] : []
  yield {
    type: 'message_complete',
    message: {
      role: 'assistant',
      content,
      turn: 0,
      provider: 'local',
      tokenEstimate: estimateTokens(fullText),
    },
    stopReason: 'end_turn',
    usage: {
      inputTokens: estimateTokens(JSON.stringify(openaiMessages)),
      outputTokens: estimateTokens(fullText),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  }
}

export function createLocalModelClient(endpoint: string, defaultModel: string): ModelClient {
  let available: boolean | null = null

  return {
    provider: 'local',

    async *stream(options: ModelCallOptions): AsyncGenerator<StreamEvent> {
      yield* withRetry(() => streamImpl(endpoint, defaultModel, options), { signal: options.signal })
    },

    async isAvailable(): Promise<boolean> {
      // Always re-check — exo cluster may start late or go down
      try {
        const resp = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(3000) })
        available = resp.ok
      } catch {
        available = false
      }
      return available
    },
  }
}
