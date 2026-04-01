import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const inputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory to search in (defaults to cwd)'),
  glob: z.string().optional().describe('File glob filter (e.g., "*.ts")'),
  max_results: z.number().optional().describe('Maximum number of results (default: 50)'),
})

export const GrepTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: 'Grep',
  description: 'Search file contents using ripgrep. Returns matching file paths and lines.',
  inputSchema,
  isConcurrencySafe: true, // read-only

  async call(input) {
    try {
      const args = ['rg', '--no-heading', '--line-number', '--max-columns', '200']
      if (input.glob) args.push('--glob', input.glob)
      const maxResults = input.max_results ?? 50
      args.push('--max-count', String(maxResults))
      args.push('--', input.pattern)
      args.push(input.path ?? process.cwd())

      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode === 1) return { content: 'No matches found.' }
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return { content: `Grep error: ${stderr}`, isError: true }
      }

      const lines = stdout.trim().split('\n').filter(Boolean)
      const header = `Found ${lines.length} matches:\n`

      // Convert absolute paths to relative
      const cwd = process.cwd()
      const relative = lines.map(l => l.startsWith(cwd) ? l.slice(cwd.length + 1) : l)

      return { content: header + relative.join('\n') }
    } catch (error) {
      return {
        content: `Error running grep: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
}
