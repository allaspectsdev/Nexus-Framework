<p align="center">
  <strong>N<span>X</span></strong>
</p>

<h1 align="center">Nexus Framework</h1>

<p align="center">
  <em>A hybrid multi-agent orchestration framework that routes between Claude and local models.<br/>Opus-class reasoning where it matters. Commodity inference where it doesn't.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> |
  <a href="#interactive-dashboard">Dashboard</a> |
  <a href="#core-concepts">How It Works</a> |
  <a href="#mcp-integration">MCP</a> |
  <a href="#observer-system">Observers</a> |
  <a href="#extending-nexus">Extend</a>
</p>

<p align="center">
  <img alt="Tests" src="https://img.shields.io/badge/tests-135%20passing-brightgreen" />
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-blue" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-bun-orange" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-purple" />
</p>

---

## What Is This?

Nexus is an AI agent framework that does something simple but powerful: it looks at each task and decides whether to send it to Claude (expensive, brilliant) or your local model (free, good enough). The result is **60-75% cost reduction** without sacrificing quality where it matters.

But it's more than a router. It's a complete agent runtime with:

- **Multi-agent coordination** -- a coordinator spawns parallel workers, each with their own tool access
- **Meta-cognitive observers** -- a "second brain" that silently watches the conversation, catches mistakes, and writes memories
- **Interactive web dashboard** -- submit queries, watch streaming responses, see real-time metrics
- **MCP integration** -- both server (expose Nexus as a tool) and client (consume external MCP servers)
- **Conversation persistence** -- SQLite-backed history with multi-turn context replay

Built entirely by Claude Code. Every line.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/allaspectsdev/Nexus-Framework.git
cd Nexus-Framework
bun install

# Configure
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# Run
bun start "analyze this project"
```

That's it. Nexus will:
1. Check if your local model is available (optional)
2. Route the task to the best model
3. Execute tools (file reads, grep, bash) as needed
4. Stream the response with a live terminal status bar
5. Show cost savings in real-time

### More Ways to Run

```bash
# Multi-agent mode -- spawns parallel workers
bun start -m "review this codebase for security issues"

# Interactive web UI at localhost:3456
# Just run Nexus and open your browser
bun start

# MCP server mode -- use Nexus from Claude Code
bun start --mcp

# Docker
docker build -t nexus .
docker run -e ANTHROPIC_API_KEY=sk-ant-... -p 3456:3456 nexus
```

---

## Interactive Dashboard

Open **http://localhost:3456** while Nexus is running. It's not just metrics -- it's a full query interface.

**Left panel:** Chat with Nexus directly from the browser. Streaming markdown rendering, expandable tool call cards, agent lifecycle events, mode toggle (single/multi-agent), conversation history sidebar.

**Right panel:** Live metrics -- token flow chart, cost savings, agent timeline with pulsing status dots, routing split bar, context decay stats, event log.

Everything updates in real-time via SSE. No polling. No page reloads.

---

## Architecture

```
                          User (CLI / Web UI / MCP)
                                    |
                                    v
 +--------------------------------------------------------------+
 |                         QueryLoop                             |
 |              flat while(true) state machine                   |
 |                                                               |
 |   Router -----> Claude API  (reasoning, code, architecture)   |
 |        \------> Local Model (summaries, classification, free) |
 |                                                               |
 |   StreamingToolExecutor        ContextManager                 |
 |   (parallel reads,             (full -> summary -> stub       |
 |    serial writes)               tiered decay)                 |
 |                                                               |
 |   Coordinator --> Worker --> Worker --> Worker                 |
 |   (LLM-driven task decomposition, parallel execution)         |
 +--------------------------------------------------------------+
          |              |              |
          v              v              v
     ObserverManager  EventBus     ConversationStore
     (safety, memory, (metrics,    (SQLite, multi-turn
      cost watchers)   dashboard)   history replay)
```

---

## Core Concepts

### Hybrid Routing -- The Right Model for the Job

Not every task needs Claude. Nexus classifies each request and routes accordingly:

| Send to Local (free) | Send to Claude (smart) |
|---|---|
| Summarize this file | Implement authentication |
| List the directories | Debug this race condition |
| Format this as JSON | Review for security issues |
| Count the matches | Architect the database schema |

The router re-checks local model availability every 30 seconds. If your exo cluster goes down, Nexus falls back to Claude seamlessly. When it comes back, Nexus notices and starts routing to it again.

### Tiered Context Decay -- Forget Gracefully

Old tool results bloat your context window. Nexus compresses them progressively:

| Age | What Happens | Token Cost |
|---|---|---|
| Recent (0-2 turns) | Full output preserved | 100% |
| Medium (3-5 turns) | Summarized by local model (free) | ~10% |
| Old (6+ turns) | One-line stub | ~1% |

This cuts mid-session context by 40-60% without losing awareness of what happened.

### Streaming Tool Execution -- Don't Wait

Tools start running while the model is still talking. Read-only tools (`ReadFile`, `Grep`) run in parallel. Write tools (`Bash`, `WriteFile`) queue and run serially. A failed concurrent tool cancels its siblings but doesn't kill the serial queue.

### Multi-Agent Coordination -- Divide and Conquer

```bash
bun start -m "review this codebase"
```

The coordinator asks a model to decompose the task into 2-4 independent directives, then spawns parallel workers. Each worker runs its own query loop with full tool access. Results are synthesized into a unified response.

Workers share an identical system prompt prefix for **prompt cache sharing** -- workers 2-4 get cache hits on the shared tokens.

---

## Observer System

The meta-cognitive observer is the most unusual feature. It's a lightweight "second brain" that runs side-inference after each turn, watching for things the primary model misses.

| Observer | What It Does | Blocks? | Cost |
|---|---|---|---|
| **Safety** | Reviews each turn for contradictions, hallucinations, security issues | Yes (priority 10) | 1 local inference |
| **Cost** | Detects repeated tool calls, token waste, model going in circles | No | Zero (pure heuristics) |
| **Memory** | Decides what's worth remembering for future conversations | No | 1 local inference |

The key insight: **the primary model never knows observers exist**. It just does its job. The observers watch silently, write memories in the background, and surface warnings through the EventBus. Next conversation, memories appear in the system prompt as if they were always there.

Custom observers are just objects implementing the `Observer` interface:

```typescript
const myObserver: Observer = {
  name: 'my-watcher',
  trigger: 'every_turn',
  blocking: false,
  async run(snapshot, ctx) {
    const analysis = await ctx.infer('Is this response accurate?')
    return { actions: [{ type: 'log', message: analysis, severity: 'info' }] }
  },
}
observerManager.register(myObserver)
```

---

## MCP Integration

### As a Server (expose Nexus to Claude Code)

```json
{
  "mcpServers": {
    "nexus": { "command": "bun", "args": ["run", "src/index.ts", "--mcp"] }
  }
}
```

Tools: `nexus_status`, `nexus_query`, `nexus_configure`

### As a Client (consume external MCP servers)

Create `.nexus/mcp.json`:

```json
{
  "servers": [
    { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    { "name": "postgres", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] }
  ]
}
```

Nexus connects to each server on startup, discovers their tools, and registers them with namespaced names (`github_search_repos`, `postgres_query`). The model sees them alongside built-in tools and can use them transparently.

---

## Security

| Layer | What We Do |
|---|---|
| **Tool paths** | `assertWithinRoot()` -- tools can't read/write outside the project |
| **BashTool** | Env allowlist (PATH, HOME, etc.) -- API keys never leak to subprocesses |
| **Agent output** | XML-escaped notifications -- workers can't inject prompts into the coordinator |
| **Dashboard** | `textContent` everywhere -- no innerHTML XSS vectors |
| **SSE** | `cancel()` hooks -- disconnected clients don't leak intervals or listeners |
| **Config** | Zod validation with ranges -- NaN and out-of-bound values fail fast |
| **API calls** | Retry with exponential backoff -- transient 429/500 errors handled automatically |

---

## Configuration

All via environment variables. Validated with Zod on startup.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6-20250514` | Claude model |
| `EXO_ENDPOINT` | `http://localhost:52415/v1` | Local model endpoint |
| `EXO_MODEL` | `llama-3.3-70b` | Local model name |
| `DASHBOARD_PORT` | `3456` | Web dashboard port |
| `ROUTING_COMPLEXITY_THRESHOLD` | `0.6` | Below = local, above = Claude (0-1) |
| `OBSERVERS_ENABLED` | `true` | Enable the observer system |
| `OBSERVER_SAFETY` | `true` | Enable safety observer |
| `OBSERVER_MEMORY` | `true` | Enable memory observer |
| `OBSERVER_COST` | `true` | Enable cost observer |
| `DB_PATH` | `.nexus/nexus.db` | SQLite database path |

---

## Extending Nexus

### Custom Tools

```typescript
export const SearchTool: ToolDefinition<{ query: string }> = {
  name: 'Search',
  description: 'Search the web',
  inputSchema: z.object({ query: z.string() }),
  isConcurrencySafe: true,
  async call(input, signal) {
    const results = await search(input.query, { signal })
    return { content: results }
  },
}

// Register in index.ts
const toolRegistry = createToolRegistry([...builtins, SearchTool])
```

### External Tools via MCP

Drop a `.nexus/mcp.json` file and any MCP server's tools become available to the agent automatically.

### Custom Observers

Implement the `Observer` interface. `blocking: true` for safety-critical checks (run before next turn). `blocking: false` for background analysis (fire-and-forget).

### Custom Routing

Add patterns to `CLAUDE_ONLY_PATTERNS` or `LOCAL_PATTERNS` in `Router.ts`, or replace the classifier entirely.

---

## Tech Stack

| | |
|---|---|
| **Runtime** | [Bun](https://bun.sh/) |
| **Language** | TypeScript (strict mode, ESM) |
| **LLM** | [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) + any OpenAI-compatible endpoint |
| **Protocol** | [Model Context Protocol](https://modelcontextprotocol.io/) (server + client) |
| **Web** | [Hono](https://hono.dev/) + vanilla JS + Canvas + SSE |
| **Database** | [bun:sqlite](https://bun.sh/docs/api/sqlite) (zero deps) |
| **Validation** | [Zod](https://zod.dev/) |
| **Testing** | Bun test runner (135 tests) |
| **Deploy** | Docker (`oven/bun:1`) |

---

## Project Stats

- **~5,500 lines** of TypeScript across 50+ source files
- **135 tests** across 12 test files
- **Zero runtime dependencies** beyond the Anthropic SDK, MCP SDK, Hono, Zod, and Chalk
- **Built entirely by Claude Code** in one session

---

## License

MIT -- do whatever you want with it.
