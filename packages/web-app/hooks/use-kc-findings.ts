'use client'

import { useCallback, useEffect, useRef, useState } from "react"
import {
  kcAdoptFinding,
  kcBackfill,
  kcGetFixTask,
  kcGetQueueTask,
  kcIgnoreFinding,
  kcListFindings,
  kcPatrol,
  type KcFindingView,
} from "@/lib/knowledge/knowledge-center-api"
import type { KcCardEvent, KcFindingCardData, KcFindingFixState, KcBackfillCardData } from "@/lib/knowledge-center/card-protocol"

/**
 * findings 编排 hook（票13 AC1/AC2/AC4 web 侧 Lane B store）。
 *
 * 面：
 * - 开放 findings 载入 → finding 卡（id=fnd-<findingId> 幂等锚定；夜巡新建由 Lane A
 *   沉淀进会话，本 store 覆盖「进入页面看得见在办裁决」「体检一下」两路）；
 * - adopt：POST → fix 任务轮询（GET fix/task + queue/task 位次，票06 单源）回灌
 *   data.fix；committed ⇒ 卡终态 resolved + onSettled（宿主刷健康条/tree）；
 * - ignore：POST 同步终态；
 * - patrol：POST /patrol（即时体检）后重列；
 * - backfill：POST /backfill → 摘录落 raw 回执 + compileTask 交宿主挂编译 diff 卡
 *   （feed.trackTask——「diff 卡跟随」复用票12 编译卡链，零新轮询器）。
 * 卡态覆盖层（fixStates/backfillStates）供宿主合并到 Lane A 消息卡（与 revertStates 同构）。
 */

export interface UseKcFindingsOptions {
  pollMs?: number
  /** 编译/裁决落定后回调（宿主刷新 health/tree） */
  onSettled?: () => void
  /** 回填成功后的编译投递回调（宿主 = feed.trackTask 挂 diff 卡跟随） */
  onBackfillCompile?: (taskId: string, rawPath: string) => void
}

export function viewToFindingCardData(v: KcFindingView): KcFindingCardData {
  const claims =
    typeof v.detail.old_claim === "string" && typeof v.detail.new_claim === "string"
      ? { old: v.detail.old_claim, new: v.detail.new_claim }
      : undefined
  return {
    findingId: v.id,
    kind: v.kind,
    title: v.title,
    ...(claims ? { claims } : {}),
    pages: v.pages,
    rawRef: v.rawRef,
    source: v.source,
    status: v.status,
  }
}

export function useKcFindings(opts: UseKcFindingsOptions = {}) {
  const pollMs = opts.pollMs ?? 800
  const [cards, setCards] = useState<KcCardEvent[]>([])
  const [fixStates, setFixStates] = useState<Record<string, KcFindingFixState>>({})
  const [backfillStates, setBackfillStates] = useState<Record<string, KcBackfillCardData>>({})
  /** [不用] 弃卡集（纯前端零请求——卡不再渲染；重进页面若策展人再发同卡仍可见） */
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  /** 裁决终态覆盖层（fid→终态）：覆盖任意来源卡（Lane A 消息卡同样进入终态渲染） */
  const [findingStatus, setFindingStatus] = useState<Record<string, "resolved" | "ignored">>({})
  const [patrolling, setPatrolling] = useState(false)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const cbsRef = useRef(opts)
  cbsRef.current = opts

  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers) clearTimeout(t); timers.clear() }
  }, [])

  const schedule = useCallback((fn: () => Promise<void>) => {
    const t = setTimeout(() => void fn(), pollMs)
    timersRef.current.add(t)
  }, [pollMs])

  const errFace = (err: unknown): { code: string; message: string } => {
    const e = err as { code?: string; message?: string }
    return { code: e?.code ?? "FINDINGS_ERROR", message: e?.message ?? String(err) }
  }

  const upsert = useCallback((event: KcCardEvent) => {
    setCards(prev => {
      const idx = prev.findIndex(c => c.id === event.id)
      if (idx === -1) return [...prev, event]
      const next = [...prev]
      next[idx] = event
      return next
    })
  }, [])

  const load = useCallback(async () => {
    try {
      const views = await kcListFindings("open")
      const now = new Date().toISOString()
      // 卡 id = finding id（协议 id 约定 fnd-<findingId>，findingId 本身已带 fnd- 前缀；
      // 与夜巡 Lane A 卡同址 ⇒ 同 finding 两车道天然幂等合并）
      setCards(views.map(v => ({ id: v.id, kind: "finding", ts: now, data: viewToFindingCardData(v) })))
    } catch {
      // 服务不可达：保留旧卡（CODING_STANDARDS #2——失败不伪造空态）
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const patrol = useCallback(async () => {
    setPatrolling(true)
    try {
      await kcPatrol()
      await load()
      return true
    } catch {
      return false
    } finally {
      setPatrolling(false)
    }
  }, [load])

  // 采纳任务轮询：fix 状态回灌覆盖层；committed ⇒ 卡终态 + 刷新
  const trackFix = useCallback((findingId: string, taskId: string) => {
    const attach = (fix: KcFindingFixState) => setFixStates(prev => ({ ...prev, [findingId]: fix }))
    const tick = async (): Promise<void> => {
      try {
        const [task, queue] = await Promise.all([kcGetFixTask(taskId), kcGetQueueTask(taskId)])
        if (!task) return
        const fix: KcFindingFixState = {
          taskId,
          status: task.status,
          position: queue?.state === "queued" ? queue.position : null,
          ...(task.result?.commit ? { commit: task.result.commit } : {}),
          ...(task.error ?? queue?.error ? { error: task.error ?? queue?.error } : {}),
        }
        attach(fix)
        if (task.status === "committed") {
          setFindingStatus(prev => ({ ...prev, [findingId]: "resolved" }))
          setCards(prev => prev.map(c =>
            c.kind === "finding" && (c.data as KcFindingCardData).findingId === findingId
              ? { ...c, data: { ...c.data as KcFindingCardData, status: "resolved", fix } }
              : c))
          cbsRef.current.onSettled?.()
          return
        }
        if (task.status === "failed") return
      } catch {
        // 网络瞬断继续拍
      }
      schedule(tick)
    }
    void tick()
  }, [schedule])

  const adopt = useCallback(async (findingId: string) => {
    setFixStates(prev => ({ ...prev, [findingId]: { taskId: `pending-${Date.now().toString(36)}`, status: "queued", position: null } }))
    try {
      const ack = await kcAdoptFinding(findingId)
      trackFix(findingId, ack.taskId)
    } catch (err) {
      setFixStates(prev => ({ ...prev, [findingId]: { taskId: `err-${Date.now().toString(36)}`, status: "failed", error: errFace(err) } }))
    }
  }, [trackFix])

  const ignore = useCallback(async (findingId: string) => {
    try {
      await kcIgnoreFinding(findingId)
      setFindingStatus(prev => ({ ...prev, [findingId]: "ignored" }))
      setCards(prev => prev.map(c =>
        c.kind === "finding" && (c.data as KcFindingCardData).findingId === findingId
          ? { ...c, data: { ...c.data as KcFindingCardData, status: "ignored" } }
          : c))
      cbsRef.current.onSettled?.()
    } catch {
      // 失败显形：卡不动（重试可再点）
    }
  }, [])

  const backfill = useCallback(async (cardId: string, input: { text: string; title?: string; sessionId?: string }) => {
    const patch = (next: Partial<KcBackfillCardData> & { excerpt: string }) =>
      setBackfillStates(prev => ({ ...prev, [cardId]: { ...(prev[cardId] ?? { excerpt: input.text }), ...next } }))
    patch({ excerpt: input.text, status: "submitted" })
    try {
      const ack = await kcBackfill(input)
      patch({
        excerpt: input.text,
        status: ack.compileTask ? "submitted" : "committed",
        rawPath: ack.raw.path,
        hash: ack.raw.hash,
        ...(ack.compileTask ? { taskId: ack.compileTask.taskId } : {}),
      })
      if (ack.compileTask) cbsRef.current.onBackfillCompile?.(ack.compileTask.taskId, ack.raw.path)
    } catch (err) {
      patch({ excerpt: input.text, status: "failed", error: errFace(err) })
    }
  }, [])

  const dismissBackfill = useCallback((cardId: string) => {
    setDismissed(prev => ({ ...prev, [cardId]: true }))
  }, [])

  return { cards, fixStates, backfillStates, dismissed, findingStatus, patrol, patrolling, load, adopt, ignore, backfill, dismissBackfill }
}
