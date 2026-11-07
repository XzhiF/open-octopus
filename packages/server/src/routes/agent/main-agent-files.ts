// packages/server/src/routes/agent/main-agent-files.ts
//
// Main Agent 文件树（~/.octopus/agent）。
// 分身配置窗口的「文件」页读的是 clone-files.ts；这里是主 Agent 自己的
// 工作目录：persona.md / config.yaml / memory / skills / versions / debug / reports。
//
// 只允许编辑两份「人的输入」文件：persona.md、memory/long-term.md。
// 其余（config.yaml、skills、versions、traces…）由系统维护，UI 标只读。
//
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { getAgentDir } from '../../services/agent/paths'
import { createAgentError, mapErrorToStatus } from './middleware'

export interface MainAgentFileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  readonly: boolean
  /** 目录下的直接子项数（文件为 undefined）。 */
  children?: number
}

/** 允许在 UI 里编辑的文件（相对 agent 根目录，正斜杠）。 */
const EDITABLE_FILES = new Set([
  'persona.md',
  'memory/long-term.md',
])

/** 递归扫描上限 —— 版本目录 / traces 可能很大，避免一次拉爆接口。 */
const MAX_ENTRIES = 4000

const MAX_WRITE_BYTES = 1024 * 1024

function normalizeRelative(input: string): string | null {
  const trimmed = input.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed) return ''
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null
  }
  return normalized
}

function resolveInside(root: string, relative: string): string | null {
  const target = path.resolve(root, relative)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(rootWithSep)) return null
  return target
}

function isEditable(relative: string): boolean {
  return EDITABLE_FILES.has(relative)
}

function scan(dir: string, root: string, recursive: boolean, out: MainAgentFileInfo[]): void {
  if (out.length >= MAX_ENTRIES) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    const fullPath = path.join(dir, entry.name)
    let stats: fs.Stats
    try {
      stats = fs.statSync(fullPath)
    } catch {
      continue
    }
    const relative = path.relative(root, fullPath).replace(/\\/g, '/')
    const isDir = entry.isDirectory()
    let children: number | undefined
    if (isDir) {
      try {
        children = fs.readdirSync(fullPath).length
      } catch {
        children = 0
      }
    }
    out.push({
      path: relative,
      name: entry.name,
      type: isDir ? 'directory' : 'file',
      size: isDir ? 0 : stats.size,
      modified: stats.mtime.toISOString(),
      readonly: isDir ? false : !isEditable(relative),
      children,
    })
    if (isDir && recursive) scan(fullPath, root, true, out)
  }
}

export function createMainAgentFilesRoutes(): Hono {
  const app = new Hono()

  // GET /files?path=&recursive=true —— 主 Agent 工作目录的文件树
  app.get('/files', (c) => {
    const root = getAgentDir()
    const relative = normalizeRelative(c.req.query('path') ?? '')
    if (relative === null) {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid path'), 400)
    }
    const dir = resolveInside(root, relative)
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return c.json({ files: [], path: relative })
    }
    const recursive = c.req.query('recursive') === 'true'
    const files: MainAgentFileInfo[] = []
    scan(dir, root, recursive, files)
    return c.json({ files, path: relative })
  })

  // GET /files/:path —— 读单个文件
  app.get('/files/:path{.+}', (c) => {
    const root = getAgentDir()
    const relative = normalizeRelative(c.req.param('path'))
    if (relative === null || relative === '') {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid path'), 400)
    }
    const target = resolveInside(root, relative)
    if (!target || !fs.existsSync(target)) {
      return c.json(createAgentError('NOT_FOUND', 'File not found'), 404)
    }
    const stats = fs.statSync(target)
    if (stats.isDirectory()) {
      return c.json(createAgentError('INVALID_PARAM', 'Path is a directory'), 400)
    }
    let content = ''
    try {
      content = fs.readFileSync(target, 'utf-8')
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
    return c.json({
      path: relative,
      content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      readonly: !isEditable(relative),
    })
  })

  // PUT /files/:path —— 只写白名单里的两份文件
  app.put('/files/:path{.+}', async (c) => {
    const root = getAgentDir()
    const relative = normalizeRelative(c.req.param('path'))
    if (relative === null || relative === '') {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid path'), 400)
    }
    if (!isEditable(relative)) {
      return c.json(createAgentError('READONLY', 'File is managed by the system'), 403)
    }
    const target = resolveInside(root, relative)
    if (!target) {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid path'), 400)
    }
    let body: { content?: unknown }
    try {
      body = await c.req.json<{ content?: unknown }>()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Request body must be JSON'), 400)
    }
    if (typeof body.content !== 'string') {
      return c.json(createAgentError('INVALID_PARAM', 'Request body must include "content"'), 400)
    }
    if (Buffer.byteLength(body.content, 'utf-8') > MAX_WRITE_BYTES) {
      return c.json(createAgentError('FILE_TOO_LARGE', 'File exceeds 1MB'), 413)
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, body.content, 'utf-8')
      return c.json({ ok: true, path: relative })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return app
}
