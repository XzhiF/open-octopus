import { z } from 'zod'

/**
 * Tool parameter schema using Zod.
 * Each tool declares its name, description, input schema, and execute function.
 * ponytail: uses `any` for input/output at the boundary — registry stores heterogeneous tools,
 * type safety is enforced at the Zod schema level.
 */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodSchema
  execute: (input: any) => Promise<unknown>
}

/** Manifest returned by GET /get_manifest */
export interface AgentManifest {
  name: string
  version: string
  description: string
  protocol: 'pi-agent-core'
  tools: ToolManifestEntry[]
}

export interface ToolManifestEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Request body for POST /execute_tool */
export interface ExecuteToolRequest {
  tool_name: string
  parameters: Record<string, unknown>
}

/** Response for POST /execute_tool */
export interface ExecuteToolResponse {
  success: boolean
  data?: unknown
  error?: string
}
