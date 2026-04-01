import chalk from 'chalk'
import type { MetricsCollector } from './MetricsCollector.js'
import type { EventBus } from './EventBus.js'
import { formatTokens } from '../utils/tokens.js'
import { formatCost, formatDuration } from '../utils/format.js'

/**
 * Compact ANSI terminal status bar — updates in-place.
 * Shows token flow, cost savings, agent status, and routing decisions.
 */
export function createTerminalUI(eventBus: EventBus, metricsCollector: MetricsCollector) {
  let lastLineCount = 0
  let isStreaming = false

  function clearLines(count: number) {
    for (let i = 0; i < count; i++) {
      process.stderr.write('\x1b[A\x1b[2K')
    }
  }

  function renderStatusBar(): string[] {
    const m = metricsCollector.getMetrics()
    const savings = metricsCollector.getSavings()
    const lines: string[] = []

    // Separator
    lines.push(chalk.dim('─'.repeat(72)))

    // Token flow
    const claudeIn = formatTokens(m.claude.inputTokens)
    const claudeOut = formatTokens(m.claude.outputTokens)
    const claudeCached = formatTokens(m.claude.cachedTokens)
    const localIn = formatTokens(m.local.inputTokens)
    const localOut = formatTokens(m.local.outputTokens)

    lines.push(
      chalk.cyan('Claude') + chalk.dim(': ') +
      `${claudeIn} in` + chalk.dim(' (') + chalk.green(`${claudeCached} cached`) + chalk.dim(') ') +
      `${claudeOut} out` +
      chalk.dim('  |  ') +
      chalk.yellow('Local') + chalk.dim(': ') +
      `${localIn} in ${localOut} out`
    )

    // Cost + savings
    const totalCalls = m.claude.calls + m.local.calls
    lines.push(
      chalk.dim('Cost: ') + formatCost(m.claude.cost) + chalk.dim(' claude + ') + formatCost(m.local.cost) + chalk.dim(' local') +
      chalk.dim('  |  ') +
      chalk.green(`Saved: ${formatCost(savings.costSaved)} (${savings.percentSaved.toFixed(0)}%)`) +
      chalk.dim(`  |  ${totalCalls} calls`)
    )

    // Agents + tools
    const agentStatus = m.agents.spawned > 0
      ? chalk.magenta(`Agents: ${m.agents.completed}/${m.agents.spawned} done`) +
        (m.agents.failed > 0 ? chalk.red(` ${m.agents.failed} failed`) : '')
      : chalk.dim('Agents: none')

    const toolStatus = chalk.blue(`Tools: ${m.tools.executions} exec`) +
      (m.tools.concurrent > 0 ? chalk.dim(` (${m.tools.concurrent} parallel)`) : '')

    lines.push(agentStatus + chalk.dim('  |  ') + toolStatus)

    // Context management
    if (m.context.decayActions > 0 || m.context.compactions > 0) {
      lines.push(
        chalk.dim('Context: ') +
        chalk.green(`${formatTokens(m.context.tokensSaved)} tokens recovered`) +
        chalk.dim(` via ${m.context.decayActions} decays, ${m.context.compactions} compactions`)
      )
    }

    // Routing decisions
    const routeTotal = m.routing.localDecisions + m.routing.claudeDecisions
    if (routeTotal > 0) {
      const localPct = ((m.routing.localDecisions / routeTotal) * 100).toFixed(0)
      lines.push(
        chalk.dim('Routing: ') +
        chalk.yellow(`${localPct}% local`) +
        chalk.dim(` / ${100 - parseInt(localPct)}% claude`) +
        chalk.dim(` (${routeTotal} decisions)`)
      )
    }

    // Observers
    if (m.observers.runs > 0) {
      const observerParts = [chalk.dim('Observers: ') + chalk.cyan(`${m.observers.runs} runs`)]
      if (m.observers.memoriesWritten > 0) observerParts.push(chalk.green(`${m.observers.memoriesWritten} memories`))
      if (m.observers.warnings > 0) observerParts.push(chalk.yellow(`${m.observers.warnings} warnings`))
      if (m.observers.criticals > 0) observerParts.push(chalk.red(`${m.observers.criticals} critical`))
      lines.push(observerParts.join(chalk.dim(' | ')))
    }

    lines.push(chalk.dim('─'.repeat(72)))

    return lines
  }

  // Subscribe to streaming text for live output
  const unsubscribe = eventBus.on((event) => {
    if (event.type === 'stream_text') {
      isStreaming = true
      process.stdout.write(event.text)
    }
  })

  return {
    /** Render the status bar to stderr (doesn't interfere with stdout streaming). */
    render(): void {
      if (isStreaming) {
        // Add a newline after streaming output before status bar
        process.stdout.write('\n')
        isStreaming = false
      }

      clearLines(lastLineCount)
      const lines = renderStatusBar()
      process.stderr.write(lines.join('\n') + '\n')
      lastLineCount = lines.length
    },

    /** Print a one-time log line above the status bar. */
    log(message: string): void {
      clearLines(lastLineCount)
      process.stderr.write(message + '\n')
      const lines = renderStatusBar()
      process.stderr.write(lines.join('\n') + '\n')
      lastLineCount = lines.length
    },

    /** Clear the status bar. */
    clear(): void {
      clearLines(lastLineCount)
      lastLineCount = 0
    },

    /** Unsubscribe from EventBus to prevent listener leaks. */
    destroy(): void {
      unsubscribe()
    },
  }
}

export type TerminalUI = ReturnType<typeof createTerminalUI>
