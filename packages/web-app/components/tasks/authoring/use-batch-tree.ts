// packages/web-app/components/tasks/authoring/use-batch-tree.ts
//
// #53 draft-artifact-visibility — 「草稿批次」区的数据源 hook + R1 实时侦测。
//
// 数据源 = GET /:id/batch-tree（磁盘直扫，绕开 phases[] 门控）。刷新触发四路：
//   ① mount / taskId 变；
//   ② task.version 变（agent 写 phases / 用户改行 → onMutated 重取行）；
//   ③ R1：chat.toolCalls 出现「已完成的 .scratch 写工具调用」→ debounce 800ms
//      重拉一次（连写 N 张票合并为 1 个 GET）；
//   ④ chat.streaming true→false（轮次空闲兜底：Bash 重定向等侦测不到的写方）。
// server 侧不加 fs watcher（spec K2）；[↻] 手刷走 refresh()。
// 失败语义（2026-09-09 加固）：首败 500ms 静默重试一次（连接层抖动自愈），
// 两连败才置 error 文案 + 保留旧 batches（面板其余区不受冻）。

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getBatchTree, type BatchTreeEntry, type HomeFileListingEntry } from "@/lib/tasks-api"
import type { ToolCallRecord } from "@/lib/agent/types"
import { normalizeRel } from "./phase-spec-dialog"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"

/** Tool names whose successful call means "a file just changed on disk". */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
/** ToolCallRecord statuses meaning the call COMPLETED (server executed it →
 *  the file exists). 'start'/'running'/'pending'/'fail' don't count. */
const DONE_STATUSES = new Set(["success", "result"])
/** R1 debounce: merge burst writes (spec + N tickets in one turn) into one GET. */
export const R1_DEBOUNCE_MS = 800
/** doFetch 失败后的静默重试间隔（连接层瞬时抖动的唯一缓冲带）。 */
export const RETRY_DELAY_MS = 500

/** R1 predicate (pure, unit-tested): is this tool call a file WRITE landing in
 *  `.scratch/`? Input shape is the SDK tool input verbatim (unknown type) —
 *  Write/Edit carry `file_path`, NotebookEdit `notebook_path`; tolerate
 *  backslash paths (Windows absolute homes) and non-object inputs. Deliberately
 *  NOT detecting Bash redirections (spec K2 — idle-refresh ④ + [↻] cover them). */
export function isScratchWrite(name: string, input: unknown): boolean {
  if (!WRITE_TOOLS.has(name)) return false
  if (typeof input !== "object" || input === null) return false
  const rec = input as Record<string, unknown>
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = rec[key]
    if (typeof v === "string" && v.replace(/\\/g, "/").includes(".scratch/")) return true
  }
  return false
}

export interface BatchTreeState {
  batches: BatchTreeEntry[]
  loading: boolean
  error: string | null
  /** Manual/immediate refresh ([↻] + internal triggers). Cancels a pending debounce. */
  refresh: () => void
}

export interface UseBatchTreeOptions {
  /** chat.toolCalls (R1 source). Absent (non-chat hosts/tests) → no R1 detection. */
  toolCalls?: ToolCallRecord[]
  /** chat.streaming — true→false edge schedules a fallback refresh. */
  streaming?: boolean
  /** task.version — changes on phases/spec-field writes. */
  versionKey?: number
}

export function useBatchTree(taskId: string, opts: UseBatchTreeOptions = {}): BatchTreeState {
  const { toolCalls, streaming, versionKey } = opts
  const [batches, setBatches] = useState<BatchTreeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const doFetch = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      let list: BatchTreeEntry[]
      try {
        list = await getBatchTree(taskId)
      } catch {
        // 连接层瞬时失败（keep-alive 竞态 RST / server 重启窗口 / 浏览器连接池
        // 排队被掐）— 500ms 后静默重试一次；陈旧请求/卸载直接弃棒。
        if (!mountedRef.current || seq !== seqRef.current) return
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        if (!mountedRef.current || seq !== seqRef.current) return
        list = await getBatchTree(taskId)
      }
      if (!mountedRef.current || seq !== seqRef.current) return
      setBatches(list)
      setError(null)
    } catch (err: unknown) {
      // 两次都失败才显错（错误文案保留原样 — 面板提示语义不变）。
      if (!mountedRef.current || seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : "批次目录加载失败")
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [taskId])

  const refresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    void doFetch()
  }, [doFetch])

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void doFetch()
    }, R1_DEBOUNCE_MS)
  }, [doFetch])

  // ① mount / taskId — reset + fetch.
  useEffect(() => {
    setBatches([])
    setError(null)
    setLoading(true)
    void doFetch()
  }, [doFetch])

  // ② version bumps (skip the initial render — ① already fetched).
  const firstVersionRef = useRef(true)
  useEffect(() => {
    if (firstVersionRef.current) {
      firstVersionRef.current = false
      return
    }
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on version change only
  }, [versionKey])

  // ③ R1: new completed .scratch-writing tool call → debounced re-fetch.
  // Records arrive 'start' then mutate to 'result'/'success' (same id);
  // processed-ids set makes each call trigger exactly once.
  const processedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!toolCalls) return
    let hit = false
    for (const tc of toolCalls) {
      if (processedRef.current.has(tc.id)) continue
      if (DONE_STATUSES.has(String(tc.status)) && isScratchWrite(tc.name, tc.input)) {
        processedRef.current.add(tc.id)
        hit = true
      }
    }
    if (hit) scheduleRefresh()
  }, [toolCalls, scheduleRefresh])

  // ④ streaming true→false (turn ended) — fallback for writes R1 can't see.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const now = !!streaming
    if (wasStreamingRef.current && !now) refresh()
    wasStreamingRef.current = now
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge detection only
  }, [streaming])

  // ⑤ task_artifacts_update (既有通道): home-file PUT (UI「创建骨架」/手改保存)
  // 与执行期 seed/collect 都会发——文件不是 task 行、不 bump version，这是
  // UI 自身写盘路径唯一能拿到的服务端信号。过滤本任务。
  // 2026-09-09：改走 scheduleRefresh（与 R1 共用同一 debounce 槽）—— 连续
  // artifacts 事件不再各发一次立即 GET，写风暴集中打 batch-tree 的形态消失。
  useEffect(() => {
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      TASK_ARTIFACTS_UPDATE_EVENT,
      (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { task_id?: string }
          if (payload.task_id !== taskId) return
          scheduleRefresh()
        } catch {
          // malformed payload — ignore (defensive)
        }
      },
    )
    return () => unsub()
  }, [taskId, scheduleRefresh])

  return { batches, loading, error, refresh }
}

// ── 对位纯函数（区/行/清单共用一份 batches，判据只此一家） ──────────────

/** specPath 是否是「.scratch 相对」可扫路径（绝对路径 = agent 旁路直写，
 *  batchTree 扫不到 → 不做磁盘断言，避免误报「未落盘」）。 */
export function isRelativeScratchSpec(specPath: string): boolean {
  if (!specPath) return false
  if (specPath.startsWith("/") || specPath.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(specPath)) return false
  return normalizeRel(specPath).startsWith(".scratch/")
}

/** specPath 归一后命中的落盘文件（无 = 未落盘 / 绝对路径 / tree 未载均返回 null）。 */
export function findSpecEntry(
  batches: BatchTreeEntry[],
  specPath: string,
): HomeFileListingEntry | null {
  if (!isRelativeScratchSpec(specPath)) return null
  const rel = normalizeRel(specPath)
  for (const b of batches) {
    const hit = b.files.find((f) => normalizeRel(f.path) === rel)
    if (hit) return hit
  }
  return null
}

/** specPath 所在批次目录（对位 ● 用），未命中 null。 */
export function findBatchFor(batches: BatchTreeEntry[], specPath: string): BatchTreeEntry | null {
  if (!isRelativeScratchSpec(specPath)) return null
  const rel = normalizeRel(specPath)
  return batches.find((b) => rel.startsWith(`${b.dir}/`)) ?? null
}

/** spec 内容摘要（行内展开用，纯启发式，容错优先）：
 *  kdRows = K8 表数据行数（首列行号，SKILL 行稳定纪律的锚）；
 *  excerpt = 首个非标题非引用非表格正文行（≤160 字）。 */
export function summarizeSpec(content: string): { kdRows: number; excerpt: string } {
  const lines = content.split(/\r?\n/)
  let kdRows = 0
  let excerpt = ""
  for (const line of lines) {
    if (/^\|\s*\d+\s*\|/.test(line.trim())) kdRows++
    if (!excerpt) {
      const t = line.trim()
      if (
        t.length > 0 &&
        !t.startsWith("#") && !t.startsWith(">") && !t.startsWith("|") &&
        !t.startsWith("---") && !t.startsWith("![")
      ) {
        excerpt = t.length > 160 ? t.slice(0, 160) + "…" : t
      }
    }
  }
  return { kdRows, excerpt }
}
