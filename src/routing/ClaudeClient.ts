import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ContentBlock } from '../engine/types.js'
import type { ModelClient, ModelCallOptions } from './types.js'
import { estimateTokens } from '../utils/tokens.js'

type APIMessage = Anthropic.MessageParam
type APIContentBlock = Anthropic.ContentBlockParam

function toAPIMessages(messages: Message[]): APIMessage[] {
  const result: APIMessage[] = []

  for (const msg of messages) {
    const blocks: APIContentBlock[] = []
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          blocks.push({ type: 'text', text: block.text })
          break
        case 'tool_use':
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
          break
        case 'tool_result':
          blocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content })
          break
        // Thinking blocks are not sent back to the API
      }
    }
    if (blocks.length > 0) {
      result.push({ role: msg.role, content: blocks })
    }
  }

  return result
}

/** Add cache_control breakpoint on the last message (Claude Code pattern). */
function addCacheBreakpoints(messages: APIMessage[]): APIMessage[] {
  if (messages.length === 0) return messages
  const result = messages.map(m => ({ ...m }))
  const last = result[result.length - 1]!
  if (Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1]!
    ;(lastBlock as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' }
  }
  return result
}

export function createClaudeClient(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey })

  return {
    provider: 'claude',

    async *stream(options: ModelCallOptions): AsyncGenerator<StreamEvent> {
      const apiMessages = addCacheBreakpoints(toAPIMessages(options.messages))

      const response = await client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens,
        thinking: { type: 'enabled', budget_tokens: Math.min(options.maxTokens - 1, 10000) },
        system: [{
          type: 'text',
          text: options.systemPrompt,
          cache_control: { type: 'ephemeral' },
        }],
        messages: apiMessages,
        tools: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        })),
        stream: true,
      })

      const contentBlocks: Map<number, { type: string; id?: string; name?: string; inputJson: string; text: string; thinking: string }> = new Map()

      for await (const event of response) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block
            contentBlocks.set(event.index, {
              type: block.type,
              id: 'id' in block ? block.id : undefined,
              name: 'name' in block ? block.name : undefined,
              inputJson: '',
              text: '',
              thinking: '',
            })
            if (block.type === 'tool_use') {
              yield { type: 'tool_use_start', id: block.id, name: block.name }
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta
            const acc = contentBlocks.get(event.index)
            if (!acc) break
            if (delta.type === 'text_delta') {
              acc.text += delta.text
              yield { type: 'text_delta', text: delta.text }
            } else if (delta.type === 'thinking_delta') {
              acc.thinking += delta.thinking
              yield { type: 'thinking_delta', thinking: delta.thinking }
            } else if (delta.type === 'input_json_delta') {
              acc.inputJson += delta.partial_json
              yield { type: 'tool_use_input_delta', id: acc.id ?? '', input: delta.partial_json }
            }
            break
          }
          case 'content_block_stop': {
            const acc = contentBlocks.get(event.index)
            if (acc?.type === 'tool_use' && acc.id && acc.name) {
              let input: Record<string, unknown> = {}
              try { input = JSON.parse(acc.inputJson || '{}') } catch {}
              yield { type: 'tool_use_complete', id: acc.id, name: acc.name, input }
            }
            break
          }
          case 'message_delta': {
            const assistantContent: ContentBlock[] = []
            for (const [, acc] of contentBlocks) {
              if (acc.type === 'text' && acc.text) {
                assistantContent.push({ type: 'text', text: acc.text })
              } else if (acc.type === 'thinking' && acc.thinking) {
                assistantContent.push({ type: 'thinking', thinking: acc.thinking })
              } else if (acc.type === 'tool_use' && acc.id && acc.name) {
                let input: Record<string, unknown> = {}
                try { input = JSON.parse(acc.inputJson || '{}') } catch {}
                assistantContent.push({ type: 'tool_use', id: acc.id, name: acc.name, input })
              }
            }

            const usage = event.usage
            yield {
              type: 'message_complete',
              message: {
                role: 'assistant',
                content: assistantContent,
                turn: 0, // filled by QueryLoop
                provider: 'claude',
                tokenEstimate: estimateTokens(JSON.stringify(assistantContent)),
              },
              stopReason: (event.delta as { stop_reason?: string }).stop_reason as StreamEvent extends { type: 'message_complete' } ? StreamEvent['stopReason'] : never ?? 'end_turn',
              usage: {
                inputTokens: 0, // filled from message_start
                outputTokens: usage?.output_tokens ?? 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            }
            break
          }
          case 'message_start': {
            // Capture input token usage from the message_start event
            const usage = event.message?.usage
            if (usage) {
              // We'll emit this with message_complete
            }
            break
          }
        }
      }
    },

    async isAvailable(): Promise<boolean> {
      return true // Claude API is always available if key is set
    },
  }
}
