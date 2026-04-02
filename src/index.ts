#!/usr/bin/env bun

import { loadConfig } from './config.js'
import { createClaudeClient } from './routing/ClaudeClient.js'
import { createLocalModelClient } from './routing/LocalModelClient.js'
import { createRouter } from './routing/Router.js'
import { createToolRegistry } from './tools/ToolRegistry.js'
import { createContextManager } from './context/ContextManager.js'
import { createCompactionStrategy } from './context/CompactionStrategy.js'
import { createEventBus } from './observability/EventBus.js'
import { createMetricsCollector } from './observability/MetricsCollector.js'
import { createTerminalUI } from './observability/TerminalUI.js'
import { createDashboardServer } from './dashboard/server.js'
import { queryLoop } from './engine/QueryLoop.js'
import { runCoordinator } from './agents/Coordinator.js'
import { ReadFileTool } from './tools/builtins/ReadFileTool.js'
import { BashTool } from './tools/builtins/BashTool.js'
import { GrepTool } from './tools/builtins/GrepTool.js'
import { WriteFileTool } from './tools/builtins/WriteFileTool.js'
import chalk from 'chalk'
import type { Message } from './engine/types.js'
import { formatCost } from './utils/format.js'
import { formatTokens } from './utils/tokens.js'
import { createMemoryStore } from './observer/MemoryStore.js'
import { createObserverManager } from './observer/ObserverManager.js'
import { createMcpClientManager, type McpClientManager } from './mcp/client.js'
import { createSafetyObserver } from './observer/builtins/SafetyObserver.js'
import { createMemoryObserver } from './observer/builtins/MemoryObserver.js'
import { createCostObserver } from './observer/builtins/CostObserver.js'
import { createConversationStore } from './db/ConversationStore.js'

// --- Parse CLI args ---
const args = process.argv.slice(2)
const isMultiAgent = args.includes('--multi-agent') || args.includes('-m')
const isMcp = args.includes('--mcp')
const filteredArgs = args.filter(a => !a.startsWith('-'))
const task = filteredArgs.join(' ') || 'Analyze the current directory and give a summary of the project structure.'

// --- Initialize ---
const config = loadConfig()
const eventBus = createEventBus()
const metricsCollector = createMetricsCollector(eventBus)
const terminalUI = createTerminalUI(eventBus, metricsCollector)

// Model clients
const claudeClient = createClaudeClient(config.anthropicApiKey)
const localClient = createLocalModelClient(config.exoEndpoint, config.exoModel)

// Router
const router = createRouter({ config, localClient, claudeClient })

// Tools
const toolRegistry = createToolRegistry([ReadFileTool, BashTool, GrepTool, WriteFileTool])

// MCP client — connect to external MCP servers and register their tools
let mcpManager: McpClientManager | undefined
if (config.mcpServers.length > 0) {
  mcpManager = await createMcpClientManager(config.mcpServers)
  const externalTools = mcpManager.getTools()
  if (externalTools.length > 0) {
    toolRegistry.registerTools(externalTools)
  }
} else {
  // Also check for .nexus/mcp.json file
  try {
    const mcpFile = Bun.file(`${process.cwd()}/.nexus/mcp.json`)
    if (await mcpFile.exists()) {
      const mcpConfig = JSON.parse(await mcpFile.text())
      if (Array.isArray(mcpConfig.servers) && mcpConfig.servers.length > 0) {
        mcpManager = await createMcpClientManager(mcpConfig.servers)
        toolRegistry.registerTools(mcpManager.getTools())
      }
    }
  } catch {}
}

// Context management
const contextManager = createContextManager({ config, localClient })
const compactionStrategy = createCompactionStrategy(config, localClient)

// Memory system
const memoryStore = createMemoryStore({
  memoryDir: `${process.cwd()}/${config.memoryDir}`,
  maxEntries: config.memoryMaxEntries,
  maxPromptEntries: config.memoryMaxPromptEntries,
})

// Load memories for system prompt injection
const memoryBlock = await memoryStore.buildPromptBlock()

// --- System prompt ---
const SYSTEM_PROMPT = `You are Nexus, a hybrid AI agent that routes work between local models and Claude API for maximum efficiency.

You have access to these tools:
- ReadFile: Read files from the filesystem (concurrent-safe)
- Grep: Search file contents with ripgrep (concurrent-safe)
- Bash: Execute shell commands
- WriteFile: Write content to files

When analyzing a codebase:
1. Start by reading key config files (package.json, tsconfig.json, etc.)
2. Use Grep to find important patterns
3. Read specific files for deeper understanding
4. Provide a clear, structured summary

Be concise and actionable. Focus on what matters.${memoryBlock ? '\n\n' + memoryBlock : ''}`

// Shared query dependencies — reused by CLI, MCP, and web UI
// tools uses a getter so dynamically registered tools (MCP) are always included
const queryDeps = {
  systemPrompt: SYSTEM_PROMPT,
  get tools() { return toolRegistry.getSchemas() },
  toolExecutor: toolRegistry,
  toolRegistry,
  contextManager,
  compactionStrategy,
  router,
  config,
  // Observer hook — fires at every turn boundary across all query paths
  async onTurnComplete(snapshot: import('./observer/types.js').TurnSnapshot) {
    const trigger = snapshot.transition.type === 'terminal' ? 'on_complete' as const : 'every_turn' as const
    await observerManager.notify(trigger, snapshot)
  },
}

// Observer system — meta-cognitive side-inference
const observerManager = createObserverManager({
  eventBus,
  memoryStore,
  inferenceClient: config.observerModel === 'claude' ? claudeClient : localClient,
  inferenceModel: config.observerModel === 'claude' ? config.claudeModel : config.exoModel,
})

if (config.observersEnabled) {
  if (config.observerSafety) observerManager.register(createSafetyObserver())
  if (config.observerCost) observerManager.register(createCostObserver())
  if (config.observerMemory) observerManager.register(createMemoryObserver())
}

// Dashboard (receives queryDeps to serve the interactive web UI)
// Conversation persistence
const conversationStore = createConversationStore(`${process.cwd()}/${config.dbPath}`)

const dashboard = createDashboardServer(config.dashboardPort, metricsCollector, eventBus, queryDeps, conversationStore)

// --- MCP Mode ---
if (isMcp) {
  const { createMcpServer } = await import('./mcp/server.js')
  const mcpServer = createMcpServer({
    metricsCollector,
    config,
    queryDeps,
  })
  await mcpServer.startStdio()
  // MCP server runs until stdin closes
  await new Promise(() => {}) // block forever
}

// --- Main execution ---
async function main() {
  console.log(chalk.bold(`\n  N${chalk.magenta('X')} Nexus — Hybrid Agent Framework\n`))

  // Check local model availability
  const localAvailable = await localClient.isAvailable()
  if (localAvailable) {
    console.log(chalk.green('  Local model (exo):') + ' connected')
  } else {
    console.log(chalk.yellow('  Local model (exo):') + ' unavailable — using Claude-only mode')
  }
  console.log(chalk.cyan('  Claude model:') + ` ${config.claudeModel}`)
  console.log(chalk.dim(`  Dashboard: http://localhost:${config.dashboardPort}\n`))

  // Start dashboard
  const server = dashboard.start()

  // Render initial status
  terminalUI.render()

  const abortController = new AbortController()

  function gracefulShutdown() {
    terminalUI.clear()
    console.log(chalk.dim('\nShutting down...'))

    // 1. Abort all in-flight work
    abortController.abort()

    // 2. Drain in-flight observers
    observerManager.drain().catch(() => {})
    observerManager.destroy()
    mcpManager?.destroy().catch(() => {})

    // 3. Clean up observability and database
    terminalUI.destroy()
    metricsCollector.destroy()
    conversationStore.close()

    // 4. Stop the dashboard HTTP server
    server.stop()

    // 4. Print final metrics
    const savings = metricsCollector.getSavings()
    const metrics = metricsCollector.getMetrics()
    const totalCalls = metrics.claude.calls + metrics.local.calls
    if (totalCalls > 0) {
      console.log(chalk.bold.green(`  Savings: ${savings.percentSaved.toFixed(0)}% (${formatCost(savings.costSaved)} saved)`))
      console.log(chalk.dim(`  ${totalCalls} API calls, ${formatTokens(metrics.claude.inputTokens + metrics.claude.outputTokens + metrics.local.inputTokens + metrics.local.outputTokens)} tokens total\n`))
    }

    process.exit(0)
  }

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)

  if (isMultiAgent) {
    // --- Multi-agent mode ---
    terminalUI.log(chalk.magenta('  Mode: Multi-agent coordinator'))
    terminalUI.log(chalk.dim(`  Task: ${task}\n`))

    const coordinator = runCoordinator({
      task,
      systemPrompt: SYSTEM_PROMPT,
      tools: toolRegistry.getSchemas(),
      toolRegistry,
      router,
      config,
      signal: abortController.signal,
      onTurnComplete: queryDeps.onTurnComplete,
      onEvent(event, data) {
        if (event === 'worker_spawned') {
          const d = data as { id: string; name: string; purpose: string }
          terminalUI.log(chalk.magenta(`  Agent spawned: ${d.name}`) + chalk.dim(` — ${d.purpose}`))
          eventBus.emit({ type: 'agent_lifecycle', agentId: d.id, name: d.name, status: 'running' })
        } else if (event === 'worker_completed') {
          const d = data as { taskId: string; name: string; usage: { totalTokens: number; durationMs: number } }
          terminalUI.log(chalk.green(`  Agent done: ${d.name}`))
          eventBus.emit({ type: 'agent_lifecycle', agentId: d.taskId, name: d.name, status: 'completed', durationMs: d.usage?.durationMs })
        }
        terminalUI.render()
      },
    })

    for await (const event of coordinator) {
      if (event.type === 'text_delta') {
        eventBus.emit({ type: 'stream_text', text: event.text, provider: 'claude' })
      }
      if (event.type === 'message_complete') {
        eventBus.emit({
          type: 'token_usage',
          provider: event.message.provider ?? 'claude',
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedTokens: event.usage.cacheReadTokens,
          cost: (event.usage.inputTokens / 1_000_000) * 3 + (event.usage.outputTokens / 1_000_000) * 15,
        })
        terminalUI.render()
      }
    }
  } else {
    // --- Single agent mode ---
    terminalUI.log(chalk.cyan('  Mode: Single agent'))
    terminalUI.log(chalk.dim(`  Task: ${task}\n`))

    const messages: Message[] = [{
      role: 'user',
      content: [{ type: 'text', text: task }],
      turn: 0,
    }]

    const loop = queryLoop(messages, {
      systemPrompt: SYSTEM_PROMPT,
      tools: toolRegistry.getSchemas(),
      toolExecutor: toolRegistry,
      toolRegistry,
      contextManager,
      compactionStrategy,
      router,
      config,
      signal: abortController.signal,
      onEvent(event) {
        if (event.type === 'text_delta') {
          eventBus.emit({ type: 'stream_text', text: event.text, provider: 'claude' })
        }
        if (event.type === 'tool_use_complete') {
          terminalUI.log(chalk.blue(`  Tool: ${event.name}`) + chalk.dim(` (${JSON.stringify(event.input).slice(0, 60)})`))
          eventBus.emit({ type: 'tool_execution', tool: event.name, durationMs: 0, concurrent: false, isError: false })
        }
        if (event.type === 'message_complete') {
          eventBus.emit({
            type: 'token_usage',
            provider: event.message.provider ?? 'claude',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedTokens: event.usage.cacheReadTokens,
            cost: (event.usage.inputTokens / 1_000_000) * 3 + (event.usage.outputTokens / 1_000_000) * 15,
          })
        }
        terminalUI.render()
      },
      onRoute(decision) {
        terminalUI.log(chalk.dim(`  Route: ${decision.reason}`))
        eventBus.emit({
          type: 'routing_decision',
          provider: decision.provider,
          reason: decision.reason,
          inputTokens: 0,
        })
        terminalUI.render()
      },
      onTransition(transition) {
        if (transition.type === 'terminal') {
          terminalUI.log(chalk.dim(`\n  Finished: ${transition.reason}`))
        }
      },
      onContextAction(action) {
        if (action.type === 'compact') {
          eventBus.emit({ type: 'compaction', tokensBefore: 0, tokensAfter: 0, tokensSaved: action.tokensSaved })
        } else {
          eventBus.emit({ type: 'context_decay', tier: action.type, tokensSaved: action.tokensSaved, messageCount: 1 })
        }
        terminalUI.render()
      },
      onTurnComplete: queryDeps.onTurnComplete,
    })

    let result = await loop.next()
    while (!result.done) {
      result = await loop.next()
    }
  }

  // Final status — use the same cleanup as graceful shutdown
  console.log('')
  terminalUI.render()

  const savings = metricsCollector.getSavings()
  const metrics = metricsCollector.getMetrics()
  console.log(chalk.bold.green(`\n  Savings: ${savings.percentSaved.toFixed(0)}% (${formatCost(savings.costSaved)} saved)`))
  console.log(chalk.dim(`  ${metrics.claude.calls + metrics.local.calls} API calls, ${formatTokens(metrics.claude.inputTokens + metrics.claude.outputTokens + metrics.local.inputTokens + metrics.local.outputTokens)} tokens total\n`))

  // Clean up
  await observerManager.drain()
  observerManager.destroy()
  await mcpManager?.destroy()
  terminalUI.destroy()
  metricsCollector.destroy()
  conversationStore.close()
  server.stop()
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error)
  process.exit(1)
})
