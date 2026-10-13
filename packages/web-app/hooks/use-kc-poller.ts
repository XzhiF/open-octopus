'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * 知识中心任务轮询共享核（code-review judgement：use-kc-feed/use-kc-findings
 * 的轮询 tick/卸载清定时器/网络瞬断 catch/pending-err taskId 同形收口）。
 *
 * 轮询制式（两 hook 原语义逐字保留）：
 * - **先立即一拍再按 pollMs 间隔**（`run` 起 tick，终态自停）；
 * - tick 返回 true = 终态（committed/failed/任务不可查停拍），false = 继续拍；
 * - tick 抛出 = 网络瞬断 ⇒ 吞掉继续拍（任务在跑，不许炸流）；
 * - 卸载清空全部在途定时器（长编译不拖尸）。
 * 不断言内部调用序列——纯调度基建，行为面由宿主 tick 自己决定。
 */

export interface KcPoller {
  /** 起一拍任务循环（终态返回 true 自停） */
  run(tick: () => Promise<boolean>): void
  /** 清空全部在途定时器（reset 语义） */
  stopAll(): void
}

export function useKcPoller(pollMs: number): KcPoller {
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // 卸载清全部轮询定时器（长编译不拖尸）
  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers) clearTimeout(t); timers.clear() }
  }, [])

  const schedule = useCallback((fn: () => Promise<void>) => {
    const t = setTimeout(() => void fn(), pollMs)
    timersRef.current.add(t)
  }, [pollMs])

  const run = useCallback((tick: () => Promise<boolean>) => {
    const loop = async (): Promise<void> => {
      let done = false
      try {
        done = await tick()
      } catch {
        // 网络瞬断：继续拍（任务在跑）
      }
      if (!done) schedule(loop)
    }
    void loop()
  }, [schedule])

  const stopAll = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current.clear()
  }, [])

  // pollMs 稳定 ⇒ run/stopAll 稳定引用（宿主 useCallback 依赖 poller 不被每拍重建）
  return useMemo(() => ({ run, stopAll }), [run, stopAll])
}

/**
 * POST 回执到达前的占位 taskId（卡面瞬时态形态：`pending-…` 排队 / `err-…` 失败显形）。
 * 两 hook 的 adopt/revert 同形收口。
 */
export const kcPlaceholderTaskId = (kind: 'pending' | 'err'): string => `${kind}-${Date.now().toString(36)}`

/** 错误格式化面（卡片 error 结构体；fallback code 由调用通道自带）。 */
export function kcErrFace(err: unknown, fallbackCode: string): { code: string; message: string } {
  const e = err as { code?: string; message?: string }
  return { code: e?.code ?? fallbackCode, message: e?.message ?? String(err) }
}
