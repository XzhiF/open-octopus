// packages/server/src/routes/chat-media.ts
//
// 对话里的图片字节流（2026-11-26 用户 · 无工具版缩略图）。
// <img src> 带不了 Authorization，所以不能挂在 /api/agent 的鉴权闸后面；
// 与舱文档窗（/api/cabins/:id/doc-raw）同一口径：只读、白名单、现读不缓存。
//
// 白名单按「会话」解析：cwd / 绑定的工作区 / 舱目录 + 本舱任务工作区 /
// ~/.octopus/chat-media/<session>（约定给生成图用的落点）。

import { Hono } from "hono"
import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import type { AgentSessionDAO } from "../db/dao"
import type { SessionRow } from "../db/types"

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}

const MAX_BYTES = 8 * 1024 * 1024

function expandHome(value: string): string {
  return value.replace(/^~(?=$|[\\/])/, os.homedir())
}

/** Windows 盘符大小写不敏感；POSIX 保持原样。 */
function within(target: string, root: string): boolean {
  const fold = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v)
  const t = fold(target)
  const r = fold(path.resolve(root))
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** 会话可见的媒体根（导出给单测钉白名单口径）。 */
export function chatMediaRoots(
  db: Database.Database,
  row: Pick<SessionRow, "id" | "cwd" | "workspace_id" | "cabin_id">,
): string[] {
  const out: string[] = []
  const push = (value: string | null | undefined) => {
    if (value) out.push(path.resolve(expandHome(value)))
  }

  push(row.cwd)
  if (row.workspace_id) {
    const ws = db
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(row.workspace_id) as { path?: string } | undefined
    push(ws?.path)
  }

  // 约定落点：agent 生成的临时图 / 二维码可以写到这个目录，按会话隔离。
  push(path.join(os.homedir(), ".octopus", "chat-media", row.id))
  push(path.join(os.homedir(), ".octopus", "chat-media"))

  if (row.cabin_id) {
    const cabin = db
      .prepare("SELECT path FROM cabins WHERE id = ? AND deleted_at IS NULL")
      .get(row.cabin_id) as { path?: string } | undefined
    push(cabin?.path)

    const tasks = db
      .prepare("SELECT id FROM tasks WHERE cabin_id = ?")
      .all(row.cabin_id) as Array<{ id: string }>
    for (const task of tasks) push(path.join(os.homedir(), ".octopus", "tasks", task.id))

    const workspaces = db
      .prepare(
        `SELECT DISTINCT w.path AS path
           FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.cabin_id = ?`,
      )
      .all(row.cabin_id) as Array<{ path?: string }>
    for (const ws of workspaces) push(ws.path)
  }

  return [...new Set(out)]
}

export function createChatMediaRoutes(sessionDAO: AgentSessionDAO): Hono {
  const app = new Hono()

  // GET /:sessionId/image?path=<绝对路径> —— 只出图片字节，支持 <img src> 直连。
  app.get("/:sessionId/image", (c) => {
    const row = sessionDAO.findById(c.req.param("sessionId"))
    if (!row) return c.json({ error: "session not found" }, 404)

    const raw = c.req.query("path")
    if (!raw || !raw.trim()) return c.json({ error: "Query param 'path' is required" }, 400)
    const expanded = expandHome(raw.trim())
    if (!path.isAbsolute(expanded)) return c.json({ error: "path must be absolute" }, 400)

    const abs = path.resolve(expanded)
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()]
    if (!mime) return c.json({ error: "unsupported image type" }, 415)

    const roots = chatMediaRoots(sessionDAO.getDb(), row)
    if (!roots.some((root) => within(abs, root))) {
      return c.json({ error: "path outside this chat's media roots" }, 403)
    }

    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return c.json({ error: "file not found" }, 404)
    }
    if (!st.isFile()) return c.json({ error: "not a regular file" }, 404)
    if (st.size > MAX_BYTES) return c.json({ error: "file too large" }, 413)

    const body = fs.readFileSync(abs)
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": mime,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    })
  })

  return app
}
