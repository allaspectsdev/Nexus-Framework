import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { assertWithinRoot } from '../../utils/pathSecurity.js'

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
      const searchPath = input.path ? assertWithinRoot(input.path) : process.cwd()
      args.push(searchPath)

      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
      // Read stdout and stderr concurrently before awaiting exit (avoids race)
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited

      if (exitCode === 1) return { content: 'No matches found.' }
      if (exitCode !== 0) {
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
