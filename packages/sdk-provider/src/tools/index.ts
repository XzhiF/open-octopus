import type { ToolDefinition, ToolManifestEntry } from '../types'
import { baiduGeocodeTool } from './baidu-geocode'

/** All registered tools, keyed by name */
const tools = new Map<string, ToolDefinition>()

function register(tool: ToolDefinition): void {
  tools.set(tool.name, tool)
}

// Register MVP tools
register(baiduGeocodeTool)

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name)
}

export function listTools(): ToolDefinition[] {
  return [...tools.values()]
}

/** Convert Zod schema to JSON Schema for manifest (simplified) */
function zodToJsonSchema(schema: ToolDefinition['inputSchema']): Record<string, unknown> {
  // ponytail: naive zod-to-json — covers object schemas for MVP, upgrade to zod-to-jsonschema lib when tools grow
  const shape = (schema as any)._def?.shape?.()
  if (!shape) return { type: 'object', properties: {} }

  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, def] of Object.entries(shape) as [string, any][]) {
    const isOptional = def._def?.typeName === 'ZodOptional'
    const inner = isOptional ? def._def.innerType : def

    properties[key] = {
      type: zodTypeToJsonType(inner._def?.typeName),
      description: inner._def?.description ?? '',
    }

    if (!isOptional) required.push(key)
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function zodTypeToJsonType(typeName: string): string {
  switch (typeName) {
    case 'ZodString': return 'string'
    case 'ZodNumber': return 'number'
    case 'ZodBoolean': return 'boolean'
    case 'ZodArray': return 'array'
    default: return 'string'
  }
}

export function buildToolManifest(): ToolManifestEntry[] {
  return listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  }))
}
