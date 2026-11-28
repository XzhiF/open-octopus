// packages/server/src/services/doc-file.ts
//
// 只读文档访问（2026-11-19 舱文档窗 / 2026-11-26 对话文档窗）。
// 两个入口共用这一套口径：
//   · /api/cabins/:id/doc        —— 全舱模式：本舱文档根（舱 cwd / 任务 workspace / 项目 / chat-media）
//   · /api/chat-media/:sid/doc   —— 桌面 / 经典舱：按会话解析的媒体根（cwd / workspace / 舱任务 / chat-media）
// 只读、白名单、现读不缓存；文本有大小上限，图片 / 视频 / 音频走 raw（支持 Range）。

import fs from "fs"
import os from "os"
import path from "path"

export class DocAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "DocAccessError"
  }
}

/** 文本类文档（md / yaml / json 等优化显示，html 按纯文本看，不做页面渲染）。 */
export const DOC_TEXT_EXT = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".csv", ".tsv", ".log", ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".sh", ".bash", ".zsh", ".ps1",
  ".sql", ".graphql", ".proto", ".diff", ".patch", ".rst", ".adoc",
])

/** 媒体类文档：<img> / <video> / <audio> 直连 raw 端点（只读字节流）。 */
export const DOC_MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
}

export const DOC_TEXT_MAX_BYTES = 2 * 1024 * 1024
export const DOC_RAW_MAX_BYTES = 64 * 1024 * 1024

export type DocKind = "text" | "image" | "video" | "audio" | "binary"

export interface DocPayload {
  /** 解析后的绝对路径（与请求一致）。 */
  path: string
  ext: string
  size: number
  kind: DocKind
  /** kind=text 才有 */
  content?: string
  /** 媒体类的 MIME */
  mime?: string
}

/** Windows 盘符大小写不敏感；POSIX 保持原样。 */
export function withinDocRoot(target: string, root: string): boolean {
  const fold = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v)
  const t = fold(target)
  const r = fold(path.resolve(root))
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** 绝对路径 → 校验必须落在给定文档根内。根外 403，不做任意路径读取。 */
export function resolveDocPath(
  rawPath: string,
  roots: string[],
  outsideMessage = "path outside allowed document roots",
): { abs: string; ext: string } {
  if (!rawPath.trim()) throw new DocAccessError(400, "Query param 'path' is required")
  const expanded = rawPath.trim().replace(/^~(?=$|[\\/])/, os.homedir())
  if (!path.isAbsolute(expanded)) throw new DocAccessError(400, "path must be absolute")
  const abs = path.resolve(expanded)
  if (!roots.some((root) => withinDocRoot(abs, root))) {
    throw new DocAccessError(403, outsideMessage)
  }
  return { abs, ext: path.extname(abs).toLowerCase() }
}

/** 读一份文档的元信息；文本类顺带回内容。 */
export function readDoc(abs: string, ext: string): DocPayload {
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new DocAccessError(404, "file not found")
  }
  if (!st.isFile()) throw new DocAccessError(404, "not a regular file")
  const base = { path: abs, ext, size: st.size }
  const mediaMime = DOC_MEDIA_MIME[ext]
  if (mediaMime) {
    const kind: DocKind = mediaMime.startsWith("video/")
      ? "video"
      : mediaMime.startsWith("audio/") ? "audio" : "image"
    return { ...base, kind, mime: mediaMime }
  }
  if (!DOC_TEXT_EXT.has(ext)) return { ...base, kind: "binary" }
  if (st.size > DOC_TEXT_MAX_BYTES) throw new DocAccessError(413, "file too large to read")
  return { ...base, kind: "text", content: fs.readFileSync(abs, "utf8") }
}

export type DocRawPayload =
  | { kind: "full"; mime: string; buf: Buffer }
  | { kind: "partial"; mime: string; buf: Buffer; start: number; end: number; total: number }
  | { kind: "range-not-satisfiable"; total: number }

/** 读媒体字节；带 Range 时切出 206 区间。 */
export function readDocRaw(abs: string, ext: string, rangeHeader?: string | null): DocRawPayload {
  const mime = DOC_MEDIA_MIME[ext]
  if (!mime) throw new DocAccessError(415, "unsupported raw file type")
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new DocAccessError(404, "file not found")
  }
  if (!st.isFile()) throw new DocAccessError(404, "not a regular file")
  if (st.size > DOC_RAW_MAX_BYTES) throw new DocAccessError(413, "file too large")
  const buf = fs.readFileSync(abs)
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (!m || (!m[1] && !m[2])) return { kind: "full", mime, buf }

  let start: number
  let end: number
  if (!m[1] && m[2]) {
    // 后缀区间：最后 N 字节
    const suffix = Number(m[2])
    start = Math.max(0, buf.byteLength - suffix)
    end = buf.byteLength - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Number(m[2]) : buf.byteLength - 1
  }
  end = Math.min(end, buf.byteLength - 1)
  if (!Number.isFinite(start) || start > end || start >= buf.byteLength) {
    return { kind: "range-not-satisfiable", total: buf.byteLength }
  }
  return { kind: "partial", mime, buf: buf.subarray(start, end + 1), start, end, total: buf.byteLength }
}
