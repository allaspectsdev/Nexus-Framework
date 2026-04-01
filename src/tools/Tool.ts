import { z, type ZodType } from 'zod'
import type { ToolSchema } from '../engine/types.js'

export type ToolResult = {
  content: string
  isError?: boolean
}

export type ToolDefinition<T = unknown> = {
  name: string
  description: string
  inputSchema: ZodType<T>
  /** Read-only tools can run concurrently. Write tools run serially. */
  isConcurrencySafe: boolean
  call(input: T, signal?: AbortSignal): Promise<ToolResult>
}

/** Convert a ToolDefinition to the API-compatible schema format. */
export function toolToSchema(tool: ToolDefinition): ToolSchema {
  // Extract JSON schema from Zod — Zod v3 doesn't have native toJSONSchema,
  // so we build a minimal representation for common types.
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }
}

/** Minimal Zod-to-JSON-Schema converter for tool input schemas. */
function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def

  if (def.typeName === 'ZodObject') {
    const shape = (schema as z.ZodObject<Record<string, ZodType>>).shape
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      const fieldDef = (value as unknown as { _def: Record<string, unknown> })._def
      if (fieldDef.typeName === 'ZodOptional') {
        properties[key] = zodToJsonSchema(fieldDef.innerType as ZodType)
      } else {
        properties[key] = zodToJsonSchema(value as ZodType)
        required.push(key)
      }
    }

    return { type: 'object', properties, required }
  }

  if (def.typeName === 'ZodString') return { type: 'string', description: def.description ?? '' }
  if (def.typeName === 'ZodNumber') return { type: 'number', description: def.description ?? '' }
  if (def.typeName === 'ZodBoolean') return { type: 'boolean', description: def.description ?? '' }
  if (def.typeName === 'ZodArray') {
    return { type: 'array', items: zodToJsonSchema((def as { type: ZodType }).type) }
  }
  if (def.typeName === 'ZodEnum') {
    return { type: 'string', enum: (def as { values: string[] }).values }
  }
  if (def.typeName === 'ZodDefault') return zodToJsonSchema((def as { innerType: ZodType }).innerType)
  if (def.typeName === 'ZodOptional') return zodToJsonSchema((def as { innerType: ZodType }).innerType)

  return { type: 'string' }
}
