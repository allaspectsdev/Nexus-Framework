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

// Context management
const contextManager = createContextManager({ config, localClient })
const compactionStrategy = createCompactionStrategy(config, localClient)

// Dashboard
const dashboard = createDashboardServer(config.dashboardPort, metricsCollector, eventBus)

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

Be concise and actionable. Focus on what matters.`

// --- MCP Mode ---
if (isMcp) {
  const { createMcpServer } = await import('./mcp/server.js')
  const mcpServer = createMcpServer({
    metricsCollector,
    config,
    queryDeps: {
      systemPrompt: SYSTEM_PROMPT,
      tools: toolRegistry.getSchemas(),
      toolExecutor: toolRegistry,
      toolRegistry,
      contextManager,
      compactionStrategy,
      router,
      config,
    },
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
  dashboard.start()

  // Render initial status
  terminalUI.render()

  const abortController = new AbortController()
  process.on('SIGINT', () => {
    terminalUI.clear()
    console.log(chalk.dim('\nAborted.'))
    abortController.abort()
    process.exit(0)
  })

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
    })

    let result = await loop.next()
    while (!result.done) {
      result = await loop.next()
    }
  }

  // Final status
  console.log('')
  terminalUI.render()

  const savings = metricsCollector.getSavings()
  console.log(chalk.bold.green(`\n  Total savings: ${savings.percentSaved.toFixed(0)}%\n`))
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error)
  process.exit(1)
})
