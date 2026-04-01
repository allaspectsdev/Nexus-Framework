import { z } from 'zod'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { ToolDefinition } from '../Tool.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (0-based)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
})

export const ReadFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: 'ReadFile',
  description: 'Read a file from the filesystem. Returns the file content with line numbers.',
  inputSchema,
  isConcurrencySafe: true, // read-only

  async call(input) {
    try {
      const filePath = resolve(input.file_path)
      const content = await readFile(filePath, 'utf-8')
      let lines = content.split('\n')

      const offset = input.offset ?? 0
      const limit = input.limit ?? 2000

      lines = lines.slice(offset, offset + limit)

      // Add line numbers (Claude Code's cat -n format)
      const numbered = lines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n')

      const truncated = lines.length < content.split('\n').length
      const suffix = truncated ? `\n\n(Showing lines ${offset + 1}-${offset + lines.length} of ${content.split('\n').length})` : ''

      return { content: numbered + suffix }
    } catch (error) {
      return {
        content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
}
