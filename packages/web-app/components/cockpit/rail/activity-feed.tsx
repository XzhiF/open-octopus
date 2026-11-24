'use client'

// v22 十四轮 · 右栏「活动」的数据源：本舱主会话（汐音）里正在跑的子代理 + 后台作业。
//
// 两个接口都是每轮全量电平，没有 SSE 增量：
//   · GET /api/agent/sessions/:id/subagents   —— 子代理运行中 / 已结束都返回
//   · GET /api/agent/sessions/:id/running      —— background_tasks（run_in_background）
// 4s 一轮；内容没变不换引用（签名比对），避免右栏每轮重渲染。
//
// Provider 挂在 CockpitSurface（右栏与详情窗同一个数据源）。离开舱 / 换主会话
// 自动清空并重挂轮询；请求失败沿用上一帧（不让一次抖动把按钮闪没）。

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import {
  getSessionRunning,
  listSessionBackgroundRuns,
  listSessionSubagents,
  type BackgroundRunInfo,
  type BackgroundTaskInfo,
  type SubagentRunSummary,
} from '@/lib/agent/api'
import { isSubagentLive } from '@/lib/subagent-format'
import {
  backgroundRunsSignature,
  backgroundTasksSignature,
  subagentRunsSignature,
  trimSubagentRuns,
} from './activity-model'

const POLL_MS = 4_000

export interface CockpitActivityFeed {
  /** 本舱主会话 id（详情窗拉子代理记录要用）；null = 还没接上。 */
  sessionId: string | null
  /** 已裁剪：运行中全留，已结束留最近 12 条。 */
  runs: SubagentRunSummary[]
  /** 服务端只给运行中的后台作业。 */
  backgrounds: BackgroundTaskInfo[]
  /** 后台作业留档（运行中 + 已结束），活动日志的历史来源。 */
  backgroundRuns: BackgroundRunInfo[]
  /** 按钮徽标 = 运行中总数（子代理 + 后台作业）。 */
  liveCount: number
  loading: boolean
  error: string | null
}

const EMPTY: CockpitActivityFeed = {
  sessionId: null,
  runs: [],
  backgrounds: [],
  backgroundRuns: [],
  liveCount: 0,
  loading: false,
  error: null,
}

const CockpitActivityContext = createContext<CockpitActivityFeed>(EMPTY)

export function useCockpitActivityFeed(): CockpitActivityFeed {
  return useContext(CockpitActivityContext)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function CockpitActivityProvider({ children }: { children: ReactNode }) {
  const sessionId = useCabinOptional()?.cabin?.main_session_id ?? null

  const [runs, setRuns] = useState<SubagentRunSummary[]>([])
  const [backgrounds, setBackgrounds] = useState<BackgroundTaskInfo[]>([])
  const [backgroundRuns, setBackgroundRuns] = useState<BackgroundRunInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runsSigRef = useRef('')
  const bgSigRef = useRef('')
  const bgRunsSigRef = useRef('')

  useEffect(() => {
    runsSigRef.current = ''
    bgSigRef.current = ''
    bgRunsSigRef.current = ''
    setRuns([])
    setBackgrounds([])
    setBackgroundRuns([])
    setError(null)
    if (!sessionId) {
      setLoading(false)
      return
    }

    let alive = true
    let timer: number | undefined
    setLoading(true)

    const tick = async () => {
      const [subRes, runningRes, bgRunsRes] = await Promise.allSettled([
        listSessionSubagents(sessionId),
        getSessionRunning(sessionId),
        listSessionBackgroundRuns(sessionId),
      ])
      if (!alive) return

      if (subRes.status === 'fulfilled') {
        const next = trimSubagentRuns(subRes.value.runs)
        const sig = subagentRunsSignature(next)
        if (sig !== runsSigRef.current) {
          runsSigRef.current = sig
          setRuns(next)
        }
        setError(null)
      } else {
        // 沿用上一帧：一次超时 / 连接抖动不该让活动按钮闪没。
        setError(errorText(subRes.reason))
      }

      if (runningRes.status === 'fulfilled') {
        const next = runningRes.value.background_tasks ?? []
        const sig = backgroundTasksSignature(next)
        if (sig !== bgSigRef.current) {
          bgSigRef.current = sig
          setBackgrounds(next)
        }
      }

      if (bgRunsRes.status === 'fulfilled') {
        const next = bgRunsRes.value.runs ?? []
        const sig = backgroundRunsSignature(next)
        if (sig !== bgRunsSigRef.current) {
          bgRunsSigRef.current = sig
          setBackgroundRuns(next)
        }
      }

      setLoading(false)
      timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }

    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [sessionId])

  const value = useMemo<CockpitActivityFeed>(() => ({
    sessionId,
    runs,
    backgrounds,
    backgroundRuns,
    liveCount: runs.filter(isSubagentLive).length + backgrounds.length,
    loading,
    error,
  }), [sessionId, runs, backgrounds, backgroundRuns, loading, error])

  return (
    <CockpitActivityContext.Provider value={value}>
      {children}
    </CockpitActivityContext.Provider>
  )
}
