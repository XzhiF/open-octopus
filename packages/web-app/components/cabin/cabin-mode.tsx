'use client'

// 桌面壳内的工作舱模式（2026-11-13）：
// 原型 index.html 里「新建工作舱 / 打开工作舱」都不改路由——左栏不动，对话区
// 换成 pendingCabin hero 或该舱的 chat。这里把这份状态提到 AppShell 层：
//   · activeCabinId：当前在桌面里打开的舱（null = 普通对话）
//   · drafting：正在新建（对话区渲染 CabinDraftPane）
// /cabin/:id 仍保留为深链兜底（CabinShell 兄弟壳），但桌面内切换不再跳路径。
//
// activeCabinId 落 localStorage：刷新后回到同一个舱（原型 hash 保视图的同义）。

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

const ACTIVE_CABIN_KEY = 'octopus.cabin.active.v1'

export interface CabinModeValue {
  activeCabinId: string | null
  drafting: boolean
  openCabin: (id: string) => void
  startDraft: () => void
  cancelDraft: () => void
  exitCabin: () => void
}

const NOOP = () => {}

/** 独立渲染（单测 / 故事）没有 provider 时保持普通对话，不抛错。 */
const FALLBACK: CabinModeValue = {
  activeCabinId: null,
  drafting: false,
  openCabin: NOOP,
  startDraft: NOOP,
  cancelDraft: NOOP,
  exitCabin: NOOP,
}

const CabinModeContext = createContext<CabinModeValue | null>(null)

function readActiveCabin(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(ACTIVE_CABIN_KEY)
  } catch {
    return null
  }
}

function writeActiveCabin(id: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (id) window.localStorage.setItem(ACTIVE_CABIN_KEY, id)
    else window.localStorage.removeItem(ACTIVE_CABIN_KEY)
  } catch {
    /* storage unavailable → 仅本次会话有效 */
  }
}

export function CabinModeProvider({ children }: { children: ReactNode }) {
  const [activeCabinId, setActiveCabinId] = useState<string | null>(readActiveCabin)
  const [drafting, setDrafting] = useState(false)

  const openCabin = useCallback((id: string) => {
    setDrafting(false)
    setActiveCabinId(id)
    writeActiveCabin(id)
  }, [])

  const startDraft = useCallback(() => {
    // 原型 newCabin()：新建期间不在任何舱里，左栏由普通对话壳继续渲染。
    setActiveCabinId(null)
    writeActiveCabin(null)
    setDrafting(true)
  }, [])

  const cancelDraft = useCallback(() => setDrafting(false), [])

  const exitCabin = useCallback(() => {
    setActiveCabinId(null)
    writeActiveCabin(null)
  }, [])

  const value = useMemo<CabinModeValue>(
    () => ({ activeCabinId, drafting, openCabin, startDraft, cancelDraft, exitCabin }),
    [activeCabinId, drafting, openCabin, startDraft, cancelDraft, exitCabin],
  )

  return <CabinModeContext.Provider value={value}>{children}</CabinModeContext.Provider>
}

export function useCabinMode(): CabinModeValue {
  return useContext(CabinModeContext) ?? FALLBACK
}
