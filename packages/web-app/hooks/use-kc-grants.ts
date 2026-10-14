'use client'

import { useCallback, useEffect, useRef, useState } from "react"
import { kcGrantDraft, kcRevokeDraft } from "@/lib/knowledge/knowledge-center-api"
import { getServerUrl } from "@/lib/server-config"
import { apiFetch } from "@/lib/api-client"
import type { SkillGrantReceipt } from "@/lib/knowledge-center/card-protocol"

/**
 * skill 授予编排 hook（P3 票05 web 侧，use-kc-cases 同族但**更薄**——授予是
 * 同步机械链（无队列任务），REST 回执即终态，零轮询）。
 *
 * 面：① 目标分身清单——复用既有 `GET /api/clones`（built-in+user；零新端点，
 *    「对话即管理」不加页面）；② 草案卡授予/撤销钮的即时覆盖层（pending 在途 /
 *    receipt 本地回执先行显形 / error 失败如实显形——Lane A 重发卡随后覆盖）。
 * 红线3：授予/撤销都是人裁治理动作，本 hook 只在**人点钮**后发请求，零自动授予；
 * 红线4：钮打的端点走票05 机械链，卡面永不出现 prompt 注入类操作。
 */

export interface KcGrantTarget {
  name: string
  display_name: string
  type: string
}

export interface KcGrantState {
  pending?: boolean
  receipt?: SkillGrantReceipt | null
  error?: string | null
}

export interface UseKcGrantsResult {
  /** 可授予分身清单（GET /api/clones 拉败=空清单诚实降级，选择器仍留「所有分身」固定项） */
  targets: KcGrantTarget[]
  /**
   * 清单拉取错误（null=正常）。非空 ⇒ 「拉不到」与「确无分身」在卡面可分辨
   * （aa-fix 项6：服务不可达≠确无，静默空清单会把故障伪装成事实）。
   */
  targetsError: string | null
  /** draftName → 钮态覆盖层（宿主 withCardStates 合并进 skill-draft 卡，任意车道生效） */
  states: Record<string, KcGrantState>
  grant: (draftName: string, cloneName: string) => Promise<void>
  revoke: (draftName: string, cloneName: string) => Promise<void>
}

export function useKcGrants(): UseKcGrantsResult {
  const [targets, setTargets] = useState<KcGrantTarget[]>([])
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, KcGrantState>>({})
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    let cancelled = false
    apiFetch(`${getServerUrl()}/api/clones`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((v: { clones?: KcGrantTarget[] }) => {
        if (!cancelled) {
          setTargets(Array.isArray(v?.clones) ? v.clones : [])
          setTargetsError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTargets([]) // 服务不可达：空清单（选择器不伪造分身）
          setTargetsError(err instanceof Error ? err.message : String(err)) // 但错误位必须显形（aa-fix 项6）
        }
      })
    return () => { cancelled = true; aliveRef.current = false }
  }, [])

  const attach = useCallback((draftName: string, st: KcGrantState) => {
    setStates(prev => ({ ...prev, [draftName]: { ...(prev[draftName] ?? {}), ...st } }))
  }, [])

  const run = useCallback(async (draftName: string, fn: () => Promise<SkillGrantReceipt>) => {
    attach(draftName, { pending: true, error: null })
    try {
      const receipt = await fn()
      attach(draftName, { pending: false, receipt, error: null })
    } catch (err) {
      attach(draftName, { pending: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [attach])

  const grant = useCallback((draftName: string, cloneName: string) =>
    run(draftName, () => kcGrantDraft(draftName, cloneName)), [run])
  const revoke = useCallback((draftName: string, cloneName: string) =>
    run(draftName, () => kcRevokeDraft(draftName, cloneName)), [run])

  return { targets, targetsError, states, grant, revoke }
}
