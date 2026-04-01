# Nexus

Hybrid multi-agent framework combining Claude API with local model inference (exo cluster).

## Conventions
- Runtime: Bun, TypeScript strict, ESM
- No classes unless genuinely needed — prefer functions + types
- Zod for all external input validation (config, MCP tools, tool inputs)
- All async operations must respect AbortSignal — propagate through every layer
- Token estimation: chars / 4 (rough, consistent with Claude Code's approach)
- Event-driven observability: all components emit to the central EventBus
- All tool execution is sandboxed: path-restricted, env-sanitized

## Architecture
- `engine/QueryLoop.ts` — flat while(true) state machine, never recursive
- `routing/` — hybrid model router (local exo cluster vs Claude API) with periodic re-detection
- `context/` — tiered tool result decay (full -> summary -> stub) + incremental compaction
- `agents/` — coordinator/worker multi-agent orchestration with LLM-driven task decomposition
- `tools/` — streaming tool execution with concurrency control and path security
- `mcp/` — MCP server for Claude Code integration with timeout and validation
- `observability/` — EventBus + MetricsCollector + TerminalUI (all with destroy() lifecycle)
- `dashboard/` — Hono SSE web dashboard with agent timeline and proper cleanup
- `utils/` — path security, XML escaping, abort helpers, token/format utilities

## Testing
- `bun test` runs 74 unit tests across 7 test files
- `bun run check` runs typecheck + tests together
- Tests cover: path security, config validation, EventBus, context decay, routing, streaming executor, agent registry

## Security
- Tool paths restricted to project root via `assertWithinRoot()`
- BashTool passes only allowlisted env vars (no API key leaks)
- Agent notifications escaped via `escapeXml()` (prevents prompt injection)
- Dashboard uses `textContent` (no innerHTML XSS)
- MCP configure validates value ranges before writing to live config
- SSE connections cleaned up properly on disconnect (cancel() hook)
