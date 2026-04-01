import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const MAX_OUTPUT_CHARS = 30_000

/** Allowlist of env vars safe to pass to subprocesses — no secrets leak. */
const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'EDITOR', 'VISUAL',
])

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}

const inputSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
})

export const BashTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: 'Bash',
  description: 'Execute a shell command and return stdout/stderr.',
  inputSchema,
  isConcurrencySafe: false, // writes to filesystem

  async call(input, signal) {
    try {
      const timeout = input.timeout ?? 30_000

      const proc = Bun.spawn(['sh', '-c', input.command], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: buildSafeEnv(),
        cwd: process.cwd(),
      })

      // Use a local AbortController as a single coordination point for cleanup
      const localAbort = new AbortController()
      const timeoutId = setTimeout(() => localAbort.abort('timeout'), timeout)
      const onParentAbort = () => localAbort.abort(signal?.reason)
      signal?.addEventListener('abort', onParentAbort, { once: true })
      localAbort.signal.addEventListener('abort', () => proc.kill(), { once: true })

      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const exitCode = await proc.exited

        let output = stdout.replace(/^(\s*\n)+/, '').trimEnd()

        // Truncate long output (Claude Code pattern: 30K chars)
        if (output.length > MAX_OUTPUT_CHARS) {
          const totalLines = output.split('\n').length
          output = output.slice(0, MAX_OUTPUT_CHARS)
          // Trim to last complete line to avoid partial line fragments
          const lastNewline = output.lastIndexOf('\n')
          if (lastNewline > 0) output = output.slice(0, lastNewline)
          const keptLines = output.split('\n').length
          output += `\n\n... [${totalLines - keptLines} lines truncated] ...`
        }

        const parts = [output]
        if (stderr.trim()) parts.push(stderr.trim())
        if (exitCode !== 0) parts.push(`Exit code: ${exitCode}`)

        return {
          content: parts.filter(Boolean).join('\n'),
          isError: exitCode !== 0,
        }
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onParentAbort)
        if (!localAbort.signal.aborted) localAbort.abort('cleanup')
      }
    } catch (error) {
      return {
        content: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
}
