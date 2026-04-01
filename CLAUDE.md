# Nexus

Hybrid multi-agent framework combining Claude API with local model inference (exo cluster).

## Conventions
- Runtime: Bun, TypeScript strict, ESM
- No classes unless genuinely needed — prefer functions + types
- Zod for all external input validation
- All async operations must respect AbortSignal
- Token estimation: chars / 4 (rough, consistent with Claude Code's approach)
- Event-driven observability: all components emit to the central EventBus

## Architecture
- `engine/QueryLoop.ts` — flat while(true) state machine, never recursive
- `routing/` — hybrid model router (local exo cluster vs Claude API)
- `context/` — tiered tool result decay (full → summary → stub)
- `agents/` — coordinator/worker multi-agent orchestration
- `tools/` — streaming tool execution with concurrency control
- `mcp/` — MCP server for Claude Code integration
- `observability/` — EventBus + MetricsCollector + TerminalUI
- `dashboard/` — Hono SSE web dashboard
