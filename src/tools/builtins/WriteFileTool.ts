import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { ToolDefinition } from '../Tool.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to write'),
  content: z.string().describe('Content to write to the file'),
})

export const WriteFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: 'WriteFile',
  description: 'Write content to a file. Creates parent directories if needed.',
  inputSchema,
  isConcurrencySafe: false, // writes

  async call(input) {
    try {
      const filePath = resolve(input.file_path)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')
      return { content: `File written successfully: ${filePath}` }
    } catch (error) {
      return {
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
}
