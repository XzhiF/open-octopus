// packages/server/src/routes/chat-media.ts
//
// 对话里的图片缩略图与文档查阅（2026-11-26 用户 · 无工具版）：
//   · GET /:sessionId/image —— <img src> 直连的图片字节（带不了 Authorization，
//     所以独立挂在 /api/agent 的鉴权闸外；与舱文档窗同一口径：只读、白名单、现读不缓存）。
//   · GET /:sessionId/doc   —— 桌面 / 经典舱聊天里的文档 chip 点开（文本回内容、媒体回 kind）。
//   · GET /:sessionId/raw   —— 媒体字节流（图片 / 视频 / 音频，支持 Range）。
//
// 白名单按「会话」解析：cwd / 绑定的工作区 / 舱目录 + 本舱项目与任务工作区 /
// ~/.octopus/chat-media/<session>（约定给生成图用的落点）。

import { Hono } from "hono"
import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import type { AgentSessionDAO } from "../db/dao"
import type { SessionRow } from "../db/types"
import { readCabinConfig } from "../services/cabin/cabin-repos"
import { readDoc, readDocRaw, resolveDocPath, withinDocRoot, DocAccessError } from "../services/doc-file"

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

    // 2026-11-26：与舱文档窗同口径 —— 项目检出 / 外部项目 / worktree 里的产物也能点开。
    if (cabin?.path) {
      try {
        for (const repo of readCabinConfig(cabin.path).repos) {
          push(repo.main_path)
          push(repo.worktree_path)
          for (const wt of repo.worktrees ?? []) push(wt.path)
          if (repo.local_path) push(path.resolve(cabin.path, repo.local_path))
        }
      } catch { /* 坏 cabin.json 不影响其余根 */ }
    }

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
    if (!roots.some((root) => withinDocRoot(abs, root))) {
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

  // GET /:sessionId/doc?path= —— 聊天里的文档 chip：文本回内容，媒体只回 kind。
  app.get("/:sessionId/doc", (c) => {
    const row = sessionDAO.findById(c.req.param("sessionId"))
    if (!row) return c.json({ error: "session not found" }, 404)
    try {
      const { abs, ext } = resolveDocPath(
        c.req.query("path") ?? "",
        chatMediaRoots(sessionDAO.getDb(), row),
        "path outside this chat's media roots",
      )
      return c.json(readDoc(abs, ext))
    } catch (err) {
      if (err instanceof DocAccessError) return c.json({ error: err.message }, err.status as 400)
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // GET /:sessionId/raw?path= —— 图片 / 视频 / 音频字节流；支持 Range（视频可拖进度）。
  app.get("/:sessionId/raw", (c) => {
    const row = sessionDAO.findById(c.req.param("sessionId"))
    if (!row) return c.json({ error: "session not found" }, 404)
    try {
      const { abs, ext } = resolveDocPath(
        c.req.query("path") ?? "",
        chatMediaRoots(sessionDAO.getDb(), row),
        "path outside this chat's media roots",
      )
      const raw = readDocRaw(abs, ext, c.req.header("range"))
      if (raw.kind === "range-not-satisfiable") {
        return c.body(null, 416, { "Content-Range": `bytes */${raw.total}` })
      }
      const headers: Record<string, string> = {
        "Content-Type": raw.mime,
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
      }
      if (raw.kind === "partial") {
        return c.body(new Uint8Array(raw.buf), 206, {
          ...headers,
          "Content-Range": `bytes ${raw.start}-${raw.end}/${raw.total}`,
          "Content-Length": String(raw.buf.byteLength),
        })
      }
      return c.body(new Uint8Array(raw.buf), 200, {
        ...headers,
        "Content-Length": String(raw.buf.byteLength),
      })
    } catch (err) {
      if (err instanceof DocAccessError) return c.json({ error: err.message }, err.status as 400)
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  return app
}
