import fs from 'fs'
import path from 'path'

/**
 * Clone change ledger — 「今日」页的「分身资产变更」唯一写入口。
 *
 * 为什么不是 DB 表：这些变更的宿主本来就是文件系统（persona.md / config.json /
 * memory/*.md / skills/），表会变成第二份真相。每个分身目录里一份 append-only
 * 的 CHANGES.jsonl，只记「谁在什么时候动了哪份资产」，内容真源仍是文件本身。
 *
 * 版本发布（agent_versions）与技能演化（evolution_log）已有各自的台账，不进本文件
 * （技能勾选变化走 kind='skill'，无对应 DB 台账）。
 *
 * 长度上限：FIFO —— 追加后超过 CLONE_CHANGES_MAX_BYTES 就只保留最新的若干行。
 * 「今日」页只读当天，上限只用于防止文件无界增长，不做历史归档。
 */

export const CLONE_CHANGES_FILE = 'CHANGES.jsonl'

/** 单个分身变更台账的容量上限（字节）。约 1000 条变更。 */
export const CLONE_CHANGES_MAX_BYTES = 128 * 1024

export type CloneChangeKind = 'memory' | 'file' | 'skill' | 'version'

export interface CloneChangeEntry {
  /** ISO 时间戳（写入时刻）。 */
  ts: string
  kind: CloneChangeKind
  /** 相对分身目录的路径；kind='skill' 时缺省。 */
  path?: string
  /** 字符数增量（memory / file）。 */
  delta_chars?: number
  /** 行数增量（memory / file）。 */
  delta_lines?: number
  /** 一句话说明（技能名、版本号、变更摘要）。 */
  summary?: string
  /** 内容摘要指纹（前 12 位），仅用于「同一次写入」判重。 */
  sha?: string
}

export function cloneChangesPath(cloneDir: string): string {
  return path.join(cloneDir, CLONE_CHANGES_FILE)
}

/**
 * 追加一条变更。永不抛 —— 记录失败不得让记忆写入/文件保存失败。
 * 返回是否落盘。
 */
export function appendCloneChange(cloneDir: string, entry: CloneChangeEntry): boolean {
  try {
    if (!cloneDir || !fs.existsSync(cloneDir)) return false
    const file = cloneChangesPath(cloneDir)
    const line = JSON.stringify(entry)
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    let next = prev.length === 0 || prev.endsWith('\n') ? `${prev}${line}\n` : `${prev}\n${line}\n`
    if (Buffer.byteLength(next, 'utf-8') > CLONE_CHANGES_MAX_BYTES) {
      next = trimOldest(next, CLONE_CHANGES_MAX_BYTES)
    }
    // tmp + rename：读侧永远看不到半行。
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, next, 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * FIFO 截断：从末尾往前保留整行，直到再加一行就超限。
 * 至少保留最后一行（单行超限也不清空台账）。
 */
export function trimOldest(content: string, maxBytes: number): string {
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  let size = 0
  let keepFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(`${lines[i]}\n`, 'utf-8')
    if (size + lineBytes > maxBytes && keepFrom < lines.length) break
    size += lineBytes
    keepFrom = i
  }
  return lines.slice(keepFrom).map((line) => `${line}\n`).join('')
}

/** 读取全部变更（按写入顺序，旧→新）。坏行静默跳过。 */
export function readCloneChanges(cloneDir: string): CloneChangeEntry[] {
  try {
    const file = cloneChangesPath(cloneDir)
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8')
      .split('\n')
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return null
        try {
          const parsed = JSON.parse(trimmed) as CloneChangeEntry
          if (!parsed || typeof parsed.ts !== 'string' || typeof parsed.kind !== 'string') return null
          return parsed
        } catch {
          return null
        }
      })
      .filter((entry): entry is CloneChangeEntry => entry !== null)
  } catch {
    return []
  }
}

/** 读取 `sinceMs` 之后的变更。 */
export function readCloneChangesSince(cloneDir: string, sinceMs: number): CloneChangeEntry[] {
  return readCloneChanges(cloneDir).filter((entry) => {
    const ts = Date.parse(entry.ts)
    return Number.isFinite(ts) && ts >= sinceMs
  })
}

/** 文本增量（字符数 / 行数）。prev 为 null 表示新建。 */
export function textDelta(prev: string | null, next: string): { delta_chars: number; delta_lines: number } {
  const prevLines = prev === null ? 0 : countLines(prev)
  return {
    delta_chars: next.length - (prev?.length ?? 0),
    delta_lines: countLines(next) - prevLines,
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  // 末尾换行不算多一行（"a\n" 是 1 行，不是 2 行）
  return text.replace(/\n$/, "").split("\n").length
}