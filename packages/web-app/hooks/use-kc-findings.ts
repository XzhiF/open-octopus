'use client'

import { useCallback, useEffect, useRef, useState } from "react"
import {
  kcAdoptFinding,
  kcBackfill,
  kcGetFixTask,
  kcGetFindingsByIds,
  kcGetQueueTask,
  kcIgnoreFinding,
  kcListFindings,
  kcPatrol,
  type KcFindingView,
} from "@/lib/knowledge/knowledge-center-api"
import type { KcCardEvent, KcFindingCardData, KcFindingFixState, KcBackfillCardData } from "@/lib/knowledge-center/card-protocol"
import { kcErrFace, kcPlaceholderTaskId, useKcPoller } from "./use-kc-poller"

/**
 * findings 编排 hook（票13 AC1/AC2/AC4 web 侧 Lane B store）。
 *
 * 面：
 * - 开放 findings 载入 → finding 卡（id=fnd-<findingId> 幂等锚定；夜巡新建由 Lane A
 *   沉淀进会话，本 store 覆盖「进入页面看得见在办裁决」「体检一下」两路）；
 * - adopt：POST → fix 任务轮询（GET fix/task + queue/task 位次，票06 单源）回灌
 *   data.fix；committed ⇒ 卡终态 resolved + onSettled（宿主刷健康条/tree）；
 * - ignore：POST 同步终态；
 * - hydrateStatuses：按 id 回填活状态（Lane A 沉淀卡刷新后只剩创建快照 → 终态修正）；
 * - patrol：POST /patrol（即时体检）后重列；
 * - backfill：POST /backfill → 摘录落 raw 回执 + compileTask 交宿主挂编译 diff 卡
 *   （feed.trackTask——「diff 卡跟随」复用票12 编译卡链，零新轮询器）。
 * 卡态覆盖层（fixStates/backfillStates）供宿主合并到 Lane A 消息卡（与 revertStates 同构）。
 * 轮询调度制式（先拍后隔/瞬断续拍/卸载清定时器/pending-err 占位 taskId）收口共享核
 * `use-kc-poller`（code-review judgement，行为零改）。
 */

export interface UseKcFindingsOptions {
  pollMs?: number
  /** 编译/裁决落定后回调（宿主刷新 health/tree） */
  onSettled?: () => void
  /** 回填成功后的编译投递回调（宿主 = feed.trackTask 挂 diff 卡跟随） */
  onBackfillCompile?: (taskId: string, rawPath: string) => void
  /**
   * 是否自动拉全库 open findings（默认 true）。
   * 主 Chat 只用 adopt/ignore/fixStates 给回流卡接线，不需要全库收件箱 ⇒ false。
   */
  autoLoad?: boolean
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
  /** 已按 id 回填过的集合（成功含 open 也记，避免反复拉；失败不记，留待下次重试） */
  const hydratedRef = useRef<Set<string>>(new Set())
  const [patrolling, setPatrolling] = useState(false)
  const cbsRef = useRef(opts)
  cbsRef.current = opts
  const poller = useKcPoller(pollMs)

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

  useEffect(() => { if (opts.autoLoad !== false) void load() }, [load, opts.autoLoad])

  /**
   * 按 id 回填活状态（2026-11-10）：Lane A finding 卡是编译时的沉淀快照，刷新后
   * 卡面 status 恒为创建时的 open。这里拿服务端真值（不限状态）覆盖终态，让
   * 「已采纳 ⇒ 已修订 / 已忽略」跨刷新成立；只问卡上出现的 id，不拉全库收件箱。
   */
  const hydrateStatuses = useCallback(async (ids: string[]) => {
    const fresh = ids.filter(id => id && !hydratedRef.current.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) hydratedRef.current.add(id)
    try {
      const views = await kcGetFindingsByIds(fresh)
      const next: Record<string, "resolved" | "ignored"> = {}
      for (const v of views) if (v.status !== "open") next[v.id] = v.status
      if (Object.keys(next).length > 0) setFindingStatus(prev => ({ ...next, ...prev }))
    } catch {
      // 服务不可达：不伪造终态，也不记已回填（下次渲染/进入可再试）
      for (const id of fresh) hydratedRef.current.delete(id)
    }
  }, [])

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
    poller.run(async (): Promise<boolean> => {
      const [task, queue] = await Promise.all([kcGetFixTask(taskId), kcGetQueueTask(taskId)])
      if (!task) return true
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
        return true
      }
      return task.status === "failed"
    })
  }, [poller])

  const adopt = useCallback(async (findingId: string) => {
    setFixStates(prev => ({ ...prev, [findingId]: { taskId: kcPlaceholderTaskId('pending'), status: "queued", position: null } }))
    try {
      const ack = await kcAdoptFinding(findingId)
      trackFix(findingId, ack.taskId)
    } catch (err) {
      setFixStates(prev => ({ ...prev, [findingId]: { taskId: kcPlaceholderTaskId('err'), status: "failed", error: kcErrFace(err, "FINDINGS_ERROR") } }))
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
      patch({ excerpt: input.text, status: "failed", error: kcErrFace(err, "FINDINGS_ERROR") })
    }
  }, [])

  const dismissBackfill = useCallback((cardId: string) => {
    setDismissed(prev => ({ ...prev, [cardId]: true }))
  }, [])

  return { cards, fixStates, backfillStates, dismissed, findingStatus, patrol, patrolling, load, hydrateStatuses, adopt, ignore, backfill, dismissBackfill }
}
