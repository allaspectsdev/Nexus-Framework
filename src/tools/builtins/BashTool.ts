import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const MAX_OUTPUT_CHARS = 30_000

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
        env: process.env,
      })

      // Race between process completion and timeout/abort
      const timeoutId = setTimeout(() => proc.kill(), timeout)
      signal?.addEventListener('abort', () => proc.kill(), { once: true })

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      clearTimeout(timeoutId)
      const exitCode = await proc.exited

      let output = stdout.replace(/^(\s*\n)+/, '').trimEnd()

      // Truncate long output (Claude Code pattern: 30K chars)
      if (output.length > MAX_OUTPUT_CHARS) {
        const lines = output.split('\n')
        output = output.slice(0, MAX_OUTPUT_CHARS)
        const remaining = lines.length - output.split('\n').length
        output += `\n\n... [${remaining} lines truncated] ...`
      }

      const parts = [output]
      if (stderr.trim()) parts.push(stderr.trim())
      if (exitCode !== 0) parts.push(`Exit code: ${exitCode}`)

      return {
        content: parts.filter(Boolean).join('\n'),
        isError: exitCode !== 0,
      }
    } catch (error) {
      return {
        content: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
}
