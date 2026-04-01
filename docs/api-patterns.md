# Anthropic API Patterns

Key SDK patterns used in Nexus, extracted from production agent implementations.

## Streaming with Cache Control

```typescript
const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 8192,
  thinking: { type: 'enabled', budget_tokens: 10000 },
  system: [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' },  // Cache the system prompt
  }],
  messages: messagesWithCacheBreakpoint,
  tools: toolSchemas,
  stream: true,
})
```

### Cache Breakpoint Placement

Place `cache_control: { type: 'ephemeral' }` on the **last content block of the last message**. This ensures the maximum prefix is cached:

```typescript
function addCacheBreakpoints(messages) {
  const last = messages[messages.length - 1]
  const lastBlock = last.content[last.content.length - 1]
  lastBlock.cache_control = { type: 'ephemeral' }
  return messages
}
```

**Why only one breakpoint?** Multiple breakpoints prevent the server from evicting intermediate KV pages. One breakpoint on the last message gives the best cache hit rate.

## Slot Reservation Optimization

Don't request 64K `max_tokens` when 95% of responses are under 5K:

```typescript
const DEFAULT_MAX_TOKENS = 8_192    // Start small
const ESCALATED_MAX_TOKENS = 64_000 // Escalate on truncation

// In the query loop:
if (stopReason === 'max_tokens' && !alreadyEscalated) {
  maxTokens = ESCALATED_MAX_TOKENS  // Retry with higher limit
  continue
}
```

This avoids reserving GPU memory slots that won't be used.

## Max Tokens Recovery

When a response is truncated even at 64K, inject a resume message:

```typescript
messages.push({
  role: 'user',
  content: [{
    type: 'text',
    text: 'Output token limit hit. Resume directly — no apology, no recap.',
  }],
})
```

The model continues seamlessly. Allow up to 3 recovery attempts before giving up.

## Stream Event Handling

Process the raw stream manually (not the SDK's helper) for lower overhead:

```typescript
for await (const event of response) {
  switch (event.type) {
    case 'content_block_start':
      // Initialize accumulator for this block index
      break
    case 'content_block_delta':
      // Append text/thinking/input_json deltas
      // Yield StreamEvent to caller immediately
      break
    case 'content_block_stop':
      // Finalize tool_use blocks (parse accumulated JSON)
      break
    case 'message_delta':
      // Capture stop_reason and final usage
      break
  }
}
```

## Tool Schema from Zod

Convert Zod schemas to JSON Schema for the API:

```typescript
const tool = {
  name: 'ReadFile',
  description: 'Read a file from the filesystem',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path' },
      limit: { type: 'number', description: 'Max lines to read' },
    },
    required: ['file_path'],
  },
}
```

Nexus includes a lightweight `zodToJsonSchema()` converter that handles the common Zod types without pulling in a full schema conversion library.

## OpenAI-Compatible Local Models

Exo, ollama, vLLM, and other local inference servers expose an OpenAI-compatible API:

```typescript
const response = await fetch('http://localhost:52415/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'llama-3.3-70b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: true,
  }),
})
```

The streaming format uses `data: [JSON]\n\n` SSE, with `data: [DONE]` as the terminator. Nexus normalizes this into the same `StreamEvent` type used by the Claude client.

## Multi-Model Cost Tracking

Track costs per provider using MTok pricing:

```typescript
const cost =
  (inputTokens / 1_000_000) * inputPrice +
  (outputTokens / 1_000_000) * outputPrice +
  (cacheReadTokens / 1_000_000) * cacheReadPrice +
  (cacheCreationTokens / 1_000_000) * cacheCreationPrice
```

For local models, all prices are $0 — the only cost is electricity.
