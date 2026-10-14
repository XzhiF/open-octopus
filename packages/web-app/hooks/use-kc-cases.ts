'use client'

import { useCallback, useRef, useState } from "react"
import { kcGetQueueTask, kcRetireCase } from "@/lib/knowledge/knowledge-center-api"
import type { KcCaseRetireState } from "@/lib/knowledge-center/card-protocol"
import { kcPlaceholderTaskId, useKcPoller } from "./use-kc-poller"

/**
 * 判例编排 hook（P3 票03 web 侧 Lane B 覆盖层，use-kc-packs 同构）。
 *
 * 面：退役钮——POST /wiki/case/retire 得 queueTaskId（car-…，case-archive opKind
 * 唯一写通道，红线2），轮询 GET /wiki/queue/task/:id（票06 位次单源）回灌覆盖层；
 * 宿主把它合并进任意来源的判例卡（Lane A 沉淀卡同样吃状态）。
 * 红线3：退役=事后纠即时执行（宽松准入的对偶），无审批态——committed 后 Lane A
 * 再沉淀 action=retired 终态卡（先存后知），本覆盖层只负责钮的即时在途显形。
 */

export interface UseKcCasesOptions {
  pollMs?: number
  /** 退役落定后回调（宿主刷新 health/tree） */
  onSettled?: () => void
}

export function useKcCases(opts: UseKcCasesOptions = {}) {
  const pollMs = opts.pollMs ?? 800
  const [retireStates, setRetireStates] = useState<Record<string, KcCaseRetireState>>({})
  const cbsRef = useRef(opts)
  cbsRef.current = opts
  const poller = useKcPoller(pollMs)

  const attach = useCallback((caseId: string, st: KcCaseRetireState) => {
    setRetireStates(prev => ({ ...prev, [caseId]: st }))
  }, [])

  const track = useCallback((caseId: string, queueTaskId: string) => {
    poller.run(async (): Promise<boolean> => {
      const q = await kcGetQueueTask(queueTaskId)
      // 任务不可查 ⇒ TASK_LOST 显式 failed（aa-fix 项5，对齐 use-kc-feed trackRetire 纪律）：
      // 队列面 404=服务重启/终态逐出，占位卡不永挂 queued——停轮询必以显形为前提。
      if (!q) {
        attach(caseId, {
          taskId: queueTaskId,
          status: "failed",
          position: null,
          error: { code: "TASK_LOST", message: "退役任务不可查（服务重启？git LOG 为审计真相）" },
        })
        return true
      }
      const st: KcCaseRetireState = {
        taskId: queueTaskId,
        status: q.state,
        position: q.state === "queued" ? q.position : null,
        ...(q.error ? { error: q.error } : {}),
      }
      attach(caseId, st)
      if (q.state === "committed" || q.state === "failed") {
        if (q.state === "committed") cbsRef.current.onSettled?.()
        return true
      }
      return false
    })
  }, [poller, attach])

  /** [退役]：POST → 占位 queued → 轮询队列任务终态回灌。 */
  const retire = useCallback(async (caseId: string) => {
    attach(caseId, { taskId: kcPlaceholderTaskId('pending'), status: "queued", position: null })
    try {
      const ack = await kcRetireCase(caseId)
      track(caseId, ack.queueTaskId)
      return ack
    } catch (err) {
      attach(caseId, {
        taskId: kcPlaceholderTaskId('pending'),
        status: "failed",
        position: null,
        error: { code: "RETIRE_FAILED", message: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }, [attach, track])

  return { retireStates, retire }
}
