import http from 'node:http'

import type { AgentManifest, ExecuteToolRequest, ExecuteToolResponse } from './types'
import { getTool, buildToolManifest } from './tools'

const manifest: AgentManifest = {
  name: 'baidu-map-provider',
  version: '1.0.0',
  description: '百度地图 SDK Provider Agent — 提供地理编码等地图能力',
  protocol: 'pi-agent-core',
  tools: buildToolManifest(),
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function handleExecuteTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req)

  let body: ExecuteToolRequest
  try {
    body = JSON.parse(raw)
  } catch {
    return json(res, 400, { success: false, error: 'Invalid JSON body' } satisfies ExecuteToolResponse)
  }

  if (!body.tool_name || typeof body.tool_name !== 'string') {
    return json(res, 400, { success: false, error: 'tool_name is required' } satisfies ExecuteToolResponse)
  }

  const tool = getTool(body.tool_name)
  if (!tool) {
    return json(res, 404, { success: false, error: `Tool not found: ${body.tool_name}` } satisfies ExecuteToolResponse)
  }

  const parsed = tool.inputSchema.safeParse(body.parameters ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return json(res, 400, { success: false, error: `Invalid parameters: ${issues}` } satisfies ExecuteToolResponse)
  }

  try {
    const data = await tool.execute(parsed.data)
    return json(res, 200, { success: true, data } satisfies ExecuteToolResponse)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return json(res, 502, { success: false, error: message } satisfies ExecuteToolResponse)
  }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    // GET /health_check
    if (method === 'GET' && url.pathname === '/health_check') {
      return json(res, 200, { status: 'ok', uptime: process.uptime() })
    }

    // GET /get_manifest
    if (method === 'GET' && url.pathname === '/get_manifest') {
      return json(res, 200, manifest)
    }

    // POST /execute_tool
    if (method === 'POST' && url.pathname === '/execute_tool') {
      return handleExecuteTool(req, res)
    }

    return json(res, 404, { error: 'Not found' })
  })
}

// For direct execution, use: pnpm start / tsx src/start.ts
