'use client'

// 单舱状态上下文：DTO + 派生视图 + 门禁快照（use-cabin 的 SSE 折叠）+ 舱浮窗
// 全几何态（P3：原型 openWin/focusWin/closeWin/min/max + drag/resize 由
// CabinModulesLayer 驱动）。数据只取一遍；开合/最小化/焦点序 API 与 P2 兼容。

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import type { CabinInitState, CabinView } from '@octopus/shared'
import { useCabin } from '@/hooks/use-cabin'
import type { CabinDetail } from '@/lib/cabin-api'
import { CABIN_WIN_SIZE } from './cabin-meta'

export interface CabinWinGeo {
  x: number
  y: number
  w: number
  h: number
  min: boolean
  max: boolean
  /** 首帧由层按容器居中+级联落位（原型 openWin）。 */
  placed: boolean
}

export interface CabinContextValue {
  cabinId: string
  cabin: CabinDetail | null
  view: CabinView | null
  initState: CabinInitState | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** 打开的舱模块窗（bottom → top 焦点序）。 */
  openWindows: string[]
  minimizedWindows: string[]
  focusedWindow: string | null
  windows: Record<string, CabinWinGeo>
  openModule: (id: string) => void
  closeModule: (id: string) => void
  minimizeModule: (id: string) => void
  focusModule: (id: string) => void
  placeModule: (id: string, x: number, y: number) => void
  moveModule: (id: string, x: number, y: number) => void
  resizeModule: (id: string, w: number, h: number) => void
  toggleMaxModule: (id: string) => void
  /** trace 窗下钻过滤（job-trace 按钮带入）。 */
  traceJobId: string | null
  setTraceJob: (id: string | null) => void
  /** classic-v3：概览/编队选中的作业（作业详情窗的数据源）。 */
  selectedJobId: string | null
  /** 打开作业详情窗并选中该作业。 */
  openJobDetail: (jobId: string) => void
  /** 任务窗的迭代筛选（概览里的迭代行会写入）；null = 全部。 */
  taskIter: string | null
  setTaskIter: (id: string | null) => void
}

const CabinContext = createContext<CabinContextValue | null>(null)

export function CabinProvider({ cabinId, children }: { cabinId: string; children: ReactNode }) {
  const { cabin, view, initState, loading, error, refresh } = useCabin(cabinId)
  const [openWindows, setOpenWindows] = useState<string[]>([])
  const [windows, setWindows] = useState<Record<string, CabinWinGeo>>({})
  const [traceJobId, setTraceJob] = useState<string | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [taskIter, setTaskIter] = useState<string | null>(null)

  const focusModule = useCallback((id: string) => {
    setOpenWindows((prev) => [...prev.filter((w) => w !== id), id])
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], min: false } } : prev))
  }, [])

  const openModule = useCallback((id: string) => {
    setOpenWindows((prev) => (prev.includes(id) ? [...prev.filter((w) => w !== id), id] : [...prev, id]))
    setWindows((prev) => {
      const cur = prev[id]
      if (cur) return { ...prev, [id]: { ...cur, min: false } }
      const [w, h] = CABIN_WIN_SIZE[id] ?? [820, 620]
      return { ...prev, [id]: { x: 0, y: 0, w, h, min: false, max: false, placed: false } }
    })
  }, [])

  const closeModule = useCallback((id: string) => {
    setOpenWindows((prev) => prev.filter((w) => w !== id))
    setWindows((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  /** classic-v3：编队点一行 → 作业详情窗（同一扇窗换目标，不叠窗）。 */
  const openJobDetail = useCallback((jobId: string) => {
    setSelectedJobId(jobId)
    openModule('job')
  }, [openModule])

  const minimizeModule = useCallback((id: string) => {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], min: true } } : prev))
  }, [])

  const placeModule = useCallback((id: string, x: number, y: number) => {
    setWindows((prev) => (prev[id] && !prev[id].placed ? { ...prev, [id]: { ...prev[id], x, y, placed: true } } : prev))
  }, [])

  const moveModule = useCallback((id: string, x: number, y: number) => {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], x, y } } : prev))
  }, [])

  const resizeModule = useCallback((id: string, w: number, h: number) => {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], w: Math.max(360, w), h: Math.max(240, h) } } : prev))
  }, [])

  const toggleMaxModule = useCallback((id: string) => {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], max: !prev[id].max } } : prev))
    setOpenWindows((prev) => [...prev.filter((w) => w !== id), id])
  }, [])

  // 初始化完成的那一刻自动开概览窗（原型 autoAdvance）：门禁 transcript 留在
  // 对话里，人第一眼看到的是派生 attention/健康度。
  const prevStatusRef = useRef<string | null>(null)
  useEffect(() => {
    const status = cabin?.status ?? null
    if (prevStatusRef.current === 'initializing' && status === 'active') {
      openModule('overview')
    }
    prevStatusRef.current = status
  }, [cabin?.status, openModule])

  // 切舱时浮窗态清零（窗属于舱，不跨舱串）。
  useEffect(() => {
    setOpenWindows([])
    setWindows({})
    setTraceJob(null)
    setSelectedJobId(null)
    setTaskIter(null)
  }, [cabinId])

  const minimizedWindows = useMemo(
    () => openWindows.filter((id) => windows[id]?.min),
    [openWindows, windows],
  )
  const focusedWindow = useMemo(
    () => [...openWindows].reverse().find((id) => !windows[id]?.min) ?? null,
    [openWindows, windows],
  )

  const value = useMemo<CabinContextValue>(() => ({
    cabinId, cabin, view, initState, loading, error, refresh,
    openWindows, minimizedWindows, focusedWindow, windows,
    openModule, closeModule, minimizeModule, focusModule,
    placeModule, moveModule, resizeModule, toggleMaxModule,
    traceJobId, setTraceJob,
    selectedJobId, openJobDetail, taskIter, setTaskIter,
  }), [
    cabinId, cabin, view, initState, loading, error, refresh,
    openWindows, minimizedWindows, focusedWindow, windows,
    openModule, closeModule, minimizeModule, focusModule,
    placeModule, moveModule, resizeModule, toggleMaxModule,
    traceJobId,
    selectedJobId, openJobDetail, taskIter,
  ])

  return <CabinContext.Provider value={value}>{children}</CabinContext.Provider>
}

export function useCabinContext(): CabinContextValue {
  const context = useContext(CabinContext)
  if (!context) throw new Error('useCabinContext must be used inside CabinProvider')
  return context
}

/** 舱外组件（如通用 transcript 里的门禁卡）可选消费：不在舱壳里时返回 null。 */
export function useCabinOptional(): CabinContextValue | null {
  return useContext(CabinContext)
}
