// packages/web-app/components/tasks/files-tab/use-round-diff-feed.ts
//
// 票 03「≡ 变更」的取数节拍（spec 故事9）：既有 GET /round-diff（round 口径）
// = 壳里的唯一轮询者。三路触发、一个节流闸：
//   ① enabled（running/paused/awaiting_review 且 v4）落位即首发；
//   ② eventSignal —— 既有 task SSE（task_execution / task_status / phase /
//      artifacts / verify）每来一发 bump 一次；够 FILE_EVENT_MIN_GAP 立即补拉，
//      不够或在飞则合并成至多一枚 trailing 定时器（事件风暴不打穿端点）；
//   ③ FILES_POLL_MS 兜底轮询 —— 没有事件的静默时段里新 commit 也 ≤10s 上屏
//      （服务端口径见 round-evidence-service.resolveRoundForDiff：live 轮
//      end 锚=当前 HEAD，端点无状态，拉即最新）。
// 数据面纪律：失败保留旧数据 + error 如实（409「无轮可供」不清屏不谎报）；
// nonce 只在成功时 +1 —— FilesTab 的「累计」口径跟同一节拍补拉，不另开闸。

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getRoundDiff, type RoundDiffPayload } from "@/lib/tasks-api"
import {
  FILES_EVENT_MIN_GAP_MS, FILES_POLL_MS, throttleDue, throttleWaitMs,
} from "./files-tab-model"

export interface RoundDiffFeed {
  data: RoundDiffPayload | null
  loading: boolean
  error: string | null
  /** 成功刷新计数 —— 切「累计」后的跟随节拍。 */
  nonce: number
  /** 错误态人工重试（绕过节流闸）。 */
  retry: () => void
}

export function useRoundDiffFeed(taskId: string, enabled: boolean, eventSignal: number): RoundDiffFeed {
  const [data, setData] = useState<RoundDiffPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const lastDone = useRef<number | null>(null)
  const inFlight = useRef(false)
  const queued = useRef(false)
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (trailing.current) clearTimeout(trailing.current)
      trailing.current = null
    }
  }, [])

  const runRef = useRef<() => void>(() => {})
  const run = useCallback(() => {
    if (inFlight.current) { queued.current = true; return }
    inFlight.current = true
    setLoading(true)
    getRoundDiff(taskId, "round")
      .then((d) => {
        if (!alive.current) return
        setData(d)
        setError(null)
        setNonce((n) => n + 1)
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        lastDone.current = Date.now()
        inFlight.current = false
        if (alive.current) setLoading(false)
        if (queued.current && alive.current) {
          queued.current = false
          runRef.current()
        }
      })
  }, [taskId])
  runRef.current = run

  // 首发 + 兜底轮询（enabled 落位即拉一次；换任务清旧不串行）。
  useEffect(() => {
    setData(null)
    setError(null)
    lastDone.current = null
    if (!enabled) return
    runRef.current()
    const id = setInterval(() => runRef.current(), FILES_POLL_MS)
    return () => clearInterval(id)
  }, [taskId, enabled])

  // SSE 事件触发（首帧不算事件）。
  const prevSig = useRef(eventSignal)
  useEffect(() => {
    if (prevSig.current === eventSignal) return
    prevSig.current = eventSignal
    if (!enabled) return
    if (trailing.current) return // 已有尾巴 → 合并（trailing 拉的是当时最新态）
    if (throttleDue(Date.now(), lastDone.current, FILES_EVENT_MIN_GAP_MS) && !inFlight.current) {
      runRef.current()
      return
    }
    const from = lastDone.current ?? Date.now()
    const wait = Math.max(throttleWaitMs(Date.now(), from, FILES_EVENT_MIN_GAP_MS), 10)
    trailing.current = setTimeout(() => {
      trailing.current = null
      runRef.current()
    }, wait)
  }, [eventSignal, enabled])

  const retry = useCallback(() => {
    if (trailing.current) { clearTimeout(trailing.current); trailing.current = null }
    runRef.current()
  }, [])

  return { data, loading, error, nonce, retry }
}
