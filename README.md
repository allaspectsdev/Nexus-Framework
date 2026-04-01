# Nexus Framework

**Hybrid multi-agent orchestration framework combining Claude API with local model inference.**

Nexus routes tasks between your local models (via [exo](https://github.com/exo-explore/exo) clusters or any OpenAI-compatible endpoint) and Claude's API based on task complexity. The result: Opus-class reasoning where it matters, commodity inference where it doesn't, and 60-75% token cost reduction.

Built entirely by Claude Code as a demonstration of advanced agentic AI patterns extracted from production-grade agent architectures.

---

## Architecture

```
User Input (CLI)
    |
    v
+---------------------------------------------------------+
|  QueryLoop (flat while(true) state machine)             |
|                                                         |
|  +---------+    +--------------------------------+      |
|  |  Router  |--->|  LocalModelClient (exo/ollama) |      |
|  |         |    |  ClaudeClient (Anthropic SDK)   |      |
|  +---------+    +--------------------------------+      |
|                                                         |
|  +---------------------+  +-----------------------+    |
|  | StreamingToolExecutor|  |   ContextManager      |    |
|  | (parallel read-only, |  | (tiered decay:        |    |
|  |  serial writes)      |  |  full->summary->stub) |    |
|  +---------------------+  +-----------------------+    |
|                                                         |
|  +---------------------------------------------------+ |
|  |  Coordinator -> Workers (LLM-driven decomposition) | |
|  +---------------------------------------------------+ |
+---------------------------------------------------------+
    |                    |
    v                    v
 Terminal UI        Web Dashboard (:3456)
 (live ANSI)        (SSE-powered)
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.1.0
- An [Anthropic API key](https://console.anthropic.com/)
- (Optional) An [exo](https://github.com/exo-explore/exo) cluster or any OpenAI-compatible local model endpoint

### Install

```bash
git clone https://github.com/allaspectsdev/Nexus-Framework.git
cd Nexus-Framework
bun install
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY
```

### Run

```bash
# Single agent -- analyzes current directory
bun start "analyze this project and summarize the architecture"

# Multi-agent -- coordinator spawns parallel workers
bun start -m "review this codebase for bugs and security issues"

# MCP server mode -- expose Nexus as a tool for Claude Code
bun start --mcp
```

### Test

```bash
# Run all tests
bun test

# Typecheck + test
bun run check

# Watch mode
bun run test:watch
```

### Docker

```bash
docker build -t nexus .
docker run -e ANTHROPIC_API_KEY=sk-ant-... -p 3456:3456 nexus "analyze this project"
```

### Dashboard

When Nexus runs, a live dashboard is available at **http://localhost:3456** showing:

- Token flow chart (Claude vs local vs cached, real-time canvas)
- Cost savings percentage and dollar amount
- Agent timeline with live status dots and durations
- Routing decision breakdown (local vs cloud split bar)
- Context decay statistics (decays, tokens saved, compactions)
- Live event log with all system events

---

## What's Fully Wired

Every system is integrated end-to-end:

- **QueryLoop** calls `ContextManager.applyDecay()` before every API request (with AbortSignal propagation) and invokes `CompactionStrategy.compact()` when context exceeds 80% capacity
- **StreamingToolExecutor** runs inside the QueryLoop -- read-only tools (`ReadFile`, `Grep`) execute in parallel, write tools (`Bash`, `WriteFile`) run serially. Race condition between concurrent and serial results is eliminated by direct return values.
- **ClaudeClient** captures `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` from the streaming `message_start` event and passes them through to the `MetricsCollector`
- **Thinking** is enabled on all Claude 4.x models (Sonnet 4, Opus 4, and their 4.6 variants), with a budget capped at 60% of `max_tokens`
- **MCP `nexus_query`** wires through the real QueryLoop with full tool execution, context management, routing, and a 2-minute AbortSignal timeout
- **MCP `nexus_configure`** validates value ranges per setting before writing to the live config object
- **Dashboard SSE** properly cleans up EventBus listeners via `cancel()` hook on client disconnect. Reconnection uses exponential backoff (1s to 10s cap).
- **Local model availability** re-checked every 30 seconds -- detects both recovery and failure of the exo cluster
- **Agent kill** actually works -- `AgentRegistry.kill()` calls `AbortController.abort()` on the worker's child signal, canceling in-flight API calls
- **Graceful shutdown** on SIGINT/SIGTERM: aborts all agents, destroys metrics/UI listeners, stops the HTTP server, prints final metrics
- **EventBus** receives events from every subsystem: token usage, routing decisions, agent lifecycle, tool execution, context decay, compaction

---

## Security

Nexus includes defense-in-depth security hardening:

| Layer | Protection |
|---|---|
| **Tool paths** | `assertWithinRoot()` restricts ReadFile, WriteFile, and Grep to the project root directory |
| **BashTool environment** | Only allowlisted env vars (PATH, HOME, etc.) passed to subprocesses -- API keys never leak |
| **BashTool lifecycle** | Local AbortController coordinates timeout, parent abort, and cleanup via `try/finally` -- no listener leaks |
| **Agent notifications** | All string fields XML-escaped via `escapeXml()` -- prevents prompt injection from worker output |
| **Dashboard XSS** | Uses `textContent` (not `innerHTML`) for all event rendering |
| **SSE connections** | `ReadableStream.cancel()` hook ensures intervals and EventBus listeners are cleaned up on disconnect |
| **Config validation** | Zod schema with range constraints on all numeric config values |
| **MCP validation** | Per-setting range validation on `nexus_configure` before mutating live config |
| **CORS** | Removed wildcard `Access-Control-Allow-Origin` from SSE endpoint |

---

## Core Concepts

### 1. Flat State-Machine Query Loop

The heart of Nexus is a `while(true)` loop with explicit state transitions -- no recursion, no callbacks. Every iteration has a clear `transition.reason` that explains why it continued or terminated.

```typescript
// engine/QueryLoop.ts
type Terminal = { type: 'terminal'; reason: 'completed' | 'max_turns' | 'aborted' | 'error' }
type Continue = { type: 'continue'; reason: 'tool_use' | 'max_tokens_escalation' | 'compact_retry' }
```

Recovery is built into the loop: `max_tokens` triggers automatic escalation from 8K to 64K, then injects resume messages. Both recovery paths increment `turnCount` to respect the `maxTurns` safety guard.

### 2. Hybrid Model Routing

The router classifies tasks and sends them to the appropriate model:

| Task Type | Routed To | Why |
|---|---|---|
| Summarization, extraction, formatting | Local model | Commodity task, near-zero cost |
| Classification, simple Q&A | Local model | Speed + cost savings |
| Code generation, architecture | Claude API | Needs strong reasoning |
| Bug diagnosis, security review | Claude API | Nuance matters |

Local model availability is re-checked every 30 seconds, detecting both recovery and failure. When unavailable, Nexus falls back gracefully to Claude-only mode.

### 3. Tiered Tool Result Decay

Tool results decay through three tiers based on age, preventing context bloat:

| Tier | Age (turns) | Content | Token Cost |
|---|---|---|---|
| **Full** | 0-2 | Complete tool output | 100% |
| **Summary** | 3-5 | One-paragraph summary (generated by local model -- free) | ~10% |
| **Stub** | 6+ | One-line indicator | ~1% |

This alone reduces mid-session context size by 40-60%. AbortSignal is propagated through the entire decay chain for cancellability.

### 4. Streaming Tool Execution

Tools begin executing while the model is still streaming its response:

- **Read-only tools** (`ReadFile`, `Grep`): run in parallel immediately
- **Write tools** (`Bash`, `WriteFile`): queue and execute serially after concurrent batch
- A sibling `AbortController` cancels concurrent tools if one errors
- Serial tools return results directly (no shared mutable array race)

### 5. LLM-Driven Multi-Agent Coordination

The coordinator uses the router to call a model (local or Claude) for intelligent task decomposition:

```
Coordinator
|-- [LLM analyzes task, generates 2-4 worker directives]
|-- Worker "planner"     -> implementation approach
|-- Worker "implementer" -> code changes
+-- Worker "validator"   -> review and verification
```

Falls back to heuristic decomposition (task-type-aware: code/analysis/general) if the LLM call fails. Workers report results via XML-escaped `<task-notification>` blocks. Workers can be killed via `AgentRegistry.kill()` which actually aborts their in-flight API calls.

### 6. MCP Server Integration

Nexus exposes itself as an MCP server, so Claude Code (or any MCP client) can use it as a tool:

```json
// .mcp.json
{
  "mcpServers": {
    "nexus": {
      "command": "bun",
      "args": ["run", "src/index.ts", "--mcp"]
    }
  }
}
```

Available MCP tools:
- `nexus_status` -- current metrics, costs, savings, agent state
- `nexus_query` -- run a query through the hybrid engine (2-minute timeout, 10-turn limit)
- `nexus_configure` -- adjust routing thresholds at runtime (range-validated)

---

## Project Structure

```
nexus/
|-- src/
|   |-- index.ts                    # CLI entrypoint with graceful shutdown
|   |-- config.ts                   # Zod-validated environment configuration
|   |
|   |-- engine/                     # Core query loop
|   |   |-- QueryLoop.ts            # Flat while(true) state machine
|   |   |-- transitions.ts          # Terminal/Continue type definitions
|   |   +-- types.ts                # Message, StreamEvent, ToolSchema
|   |
|   |-- routing/                    # Hybrid model routing
|   |   |-- Router.ts               # Complexity classifier with periodic re-detection
|   |   |-- ClaudeClient.ts         # Anthropic SDK (streaming + caching + thinking)
|   |   |-- LocalModelClient.ts     # OpenAI-compatible (exo/ollama) with abort handling
|   |   +-- types.ts                # ModelClient interface
|   |
|   |-- context/                    # Token optimization
|   |   |-- ContextManager.ts       # Tiered tool result decay with AbortSignal
|   |   |-- CompactionStrategy.ts   # Idempotent incremental summarization
|   |   +-- types.ts                # DecayTier, ContextAction
|   |
|   |-- agents/                     # Multi-agent orchestration
|   |   |-- Coordinator.ts          # LLM-driven task decomposition + synthesis
|   |   |-- Worker.ts               # Independent QueryLoop with abort cleanup
|   |   |-- AgentRegistry.ts        # Agent state tracking with kill() support
|   |   |-- notifications.ts        # XML-escaped <task-notification> format
|   |   +-- types.ts                # AgentId, AgentState (with AbortController)
|   |
|   |-- tools/                      # Tool system
|   |   |-- Tool.ts                 # Base type + Zod->JSON schema
|   |   |-- ToolRegistry.ts         # Lookup, validation, execution
|   |   |-- StreamingToolExecutor.ts# Race-free concurrent execution engine
|   |   +-- builtins/               # Built-in tools (path-restricted)
|   |       |-- ReadFileTool.ts
|   |       |-- GrepTool.ts
|   |       |-- BashTool.ts         # Sandboxed env, proper abort lifecycle
|   |       +-- WriteFileTool.ts
|   |
|   |-- mcp/                        # MCP server
|   |   +-- server.ts               # STDIO transport, 3 tools (timeout + validation)
|   |
|   |-- observability/              # Metrics and UI
|   |   |-- EventBus.ts             # Typed event emitter
|   |   |-- MetricsCollector.ts     # Token/cost/agent aggregation with destroy()
|   |   +-- TerminalUI.ts           # Live ANSI status bar with destroy()
|   |
|   |-- dashboard/                  # Web dashboard
|   |   |-- server.ts               # Hono SSE server with cancel() cleanup
|   |   +-- static/
|   |       |-- index.html
|   |       |-- app.js              # Agent timeline, debounced canvas, safe rendering
|   |       +-- styles.css
|   |
|   +-- utils/                      # Shared utilities
|       |-- pathSecurity.ts         # assertWithinRoot() path traversal guard
|       |-- escapeXml.ts            # XML entity escaping
|       |-- tokens.ts               # Token estimation
|       |-- format.ts               # Duration/cost formatting
|       +-- abort.ts                # AbortController helpers
|
|-- tests/                          # Test suite (74 tests)
|   |-- utils.test.ts               # Path security, XML escape, tokens, formatting
|   |-- config.test.ts              # Zod schema validation, loadConfig
|   |-- eventbus.test.ts            # EventBus emit/subscribe/unsubscribe
|   |-- context.test.ts             # Decay tiers, compaction idempotency
|   |-- routing.test.ts             # Purpose-based and complexity-based routing
|   |-- streaming-executor.test.ts  # Concurrent/serial execution, race regression
|   +-- agents.test.ts              # Registry CRUD, kill(), notification escaping
|
|-- .github/workflows/ci.yml       # GitHub Actions: typecheck + test
|-- Dockerfile                      # Production container (oven/bun:1)
|-- .dockerignore
|-- .env.example                    # Configuration template
|-- CLAUDE.md                       # Project conventions for AI assistants
|-- package.json
+-- tsconfig.json
```

---

## Configuration

All configuration is via environment variables (see `.env.example`). Values are validated with Zod on startup -- invalid config fails fast with clear error messages.

| Variable | Default | Range | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | non-empty string | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6-20250514` | any string | Claude model to use |
| `EXO_ENDPOINT` | `http://localhost:52415/v1` | valid URL | Local model endpoint (OpenAI-compatible) |
| `EXO_MODEL` | `llama-3.3-70b` | any string | Local model name |
| `DASHBOARD_PORT` | `3456` | 1-65535 | Web dashboard port |
| `ROUTING_COMPLEXITY_THRESHOLD` | `0.6` | 0-1 | Complexity score threshold; below -> local, above -> Claude |
| `CONTEXT_DECAY_FULL_TURNS` | `2` | 0-50 | Turns before tool results decay to summary |
| `CONTEXT_DECAY_SUMMARY_TURNS` | `5` | 1-100 | Turns before summaries decay to stubs |
| `MAX_CONCURRENT_AGENTS` | `4` | 1-20 | Maximum parallel worker agents |

---

## Extending Nexus

### Adding Custom Tools

```typescript
import { z } from 'zod'
import type { ToolDefinition } from './tools/Tool.js'

export const MyTool: ToolDefinition<{ query: string }> = {
  name: 'MyTool',
  description: 'Does something useful',
  inputSchema: z.object({ query: z.string() }),
  isConcurrencySafe: true, // true = read-only, can run in parallel
  async call(input, signal) {
    // Your implementation -- respect the signal!
    if (signal?.aborted) throw signal.reason
    return { content: `Result for: ${input.query}` }
  },
}
```

Register it in `index.ts`:
```typescript
const toolRegistry = createToolRegistry([ReadFileTool, BashTool, GrepTool, WriteFileTool, MyTool])
```

### Custom Routing Logic

Override the router's classification in `routing/Router.ts` by adding patterns to `CLAUDE_ONLY_PATTERNS` or `LOCAL_PATTERNS`, or implement a more sophisticated classifier using the local model itself.

### Custom Agent Decomposition

The `decomposeTask()` function in `agents/Coordinator.ts` uses the router to call a model for intelligent task splitting. It falls back to heuristic decomposition with task-type awareness (code/analysis/general) if the LLM call fails. You can customize the prompt, adjust the heuristic categories, or add new task-type patterns.

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict, ESM) |
| LLM API | Anthropic SDK (`@anthropic-ai/sdk`) |
| Local inference | Any OpenAI-compatible endpoint |
| Schema validation | Zod |
| MCP server | `@modelcontextprotocol/sdk` |
| Web server | Hono |
| Terminal UI | ANSI escape codes + chalk |
| Dashboard | Vanilla JS + Canvas + SSE |
| Testing | Bun test runner (built-in) |
| CI/CD | GitHub Actions |
| Deployment | Docker (oven/bun:1) |

---

## Design Principles

These patterns were extracted from analyzing production agent architectures:

1. **Flat loops over recursion** -- The query loop is a `while(true)` with explicit state transitions. No stack overflow risk, full audit trail of why each iteration happened.

2. **Commodity work stays local** -- Summarization, classification, and extraction don't need Opus-class reasoning. Run them on your own hardware for free.

3. **Progressive context decay** -- Old tool results are compressed, not deleted. The model retains awareness of what happened without paying full token cost.

4. **Tools start before the model finishes** -- Streaming tool execution overlaps model output with tool work, reducing end-to-end latency.

5. **Observe everything** -- Every token, every routing decision, every tool call flows through the EventBus. You can't optimize what you can't measure.

6. **Security by default** -- Path traversal guards, env sandboxing, XML escaping, and input validation are built into the framework, not bolted on.

7. **Clean lifecycle management** -- Every component that subscribes to events exposes a `destroy()` method. Graceful shutdown aborts all work, releases all listeners, and stops the server.

---

## License

MIT
