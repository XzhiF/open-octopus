'use client'

import { useCallback, useRef, useState } from "react"
import { kcGetQueueTask, kcRecompilePack } from "@/lib/knowledge/knowledge-center-api"
import type { KcMaterialPackRecompileState } from "@/lib/knowledge-center/card-protocol"
import { kcPlaceholderTaskId, useKcPoller } from "./use-kc-poller"

/**
 * 素材包编排 hook（P3 票02 web 侧 Lane B 覆盖层，use-kc-findings.fixStates 同构）。
 *
 * 面：剔除某件→重编译 / 焦点重编译——POST pack/recompile 得 queueTaskId
 * （arc-{taskId}-rcN），轮询 GET /wiki/queue/task/:id（票06 位次单源）回灌覆盖层；
 * 宿主把它合并进任意来源的 material-pack 卡（Lane A 沉淀卡同样吃状态）。
 * 编译结果真相 = 队列任务终态（committed/failed）；git LOG 为最终审计面。
 */

export interface UseKcPacksOptions {
  pollMs?: number
  /** 重编译落定后回调（宿主刷新 health/tree） */
  onSettled?: () => void
}

export function useKcPacks(opts: UseKcPacksOptions = {}) {
  const pollMs = opts.pollMs ?? 800
  const [recompileStates, setRecompileStates] = useState<Record<string, KcMaterialPackRecompileState>>({})
  const cbsRef = useRef(opts)
  cbsRef.current = opts
  const poller = useKcPoller(pollMs)

  const attach = useCallback((taskId: string, fix: KcMaterialPackRecompileState) => {
    setRecompileStates(prev => ({ ...prev, [taskId]: fix }))
  }, [])

  const track = useCallback((taskId: string, queueTaskId: string, input: { excludePath?: string; focus?: string }) => {
    poller.run(async (): Promise<boolean> => {
      const q = await kcGetQueueTask(queueTaskId)
      // 任务不可查 ⇒ TASK_LOST 显式 failed（aa-fix 项5，对齐 use-kc-feed trackRetire 纪律）：
      // 队列面 404=服务重启/终态逐出，占位卡不永挂 queued——停轮询必以显形为前提。
      if (!q) {
        attach(taskId, {
          taskId: queueTaskId,
          status: "failed",
          position: null,
          excludePath: input.excludePath ?? null,
          focus: input.focus ?? null,
          error: { code: "TASK_LOST", message: "重编译任务不可查（服务重启？git LOG 为审计真相）" },
        })
        return true
      }
      const st: KcMaterialPackRecompileState = {
        taskId: queueTaskId,
        status: q.state,
        position: q.state === "queued" ? q.position : null,
        excludePath: input.excludePath ?? null,
        focus: input.focus ?? null,
        ...(q.error ? { error: q.error } : {}),
      }
      attach(taskId, st)
      if (q.state === "committed" || q.state === "failed") {
        if (q.state === "committed") cbsRef.current.onSettled?.()
        return true
      }
      return false
    })
  }, [poller, attach])

  /** [剔除重编译]：POST → 占位 queued → 轮询队列任务终态回灌。 */
  const recompile = useCallback(async (taskId: string, input: { excludePath?: string; focus?: string }) => {
    attach(taskId, { taskId: kcPlaceholderTaskId('pending'), status: "queued", position: null })
    try {
      const ack = await kcRecompilePack(taskId, input)
      track(taskId, ack.queueTaskId, input)
      return ack
    } catch (err) {
      attach(taskId, {
        taskId: kcPlaceholderTaskId('pending'),
        status: "failed",
        position: null,
        error: { code: "RECOMPILE_FAILED", message: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }, [attach, track])

  return { recompileStates, recompile }
}
