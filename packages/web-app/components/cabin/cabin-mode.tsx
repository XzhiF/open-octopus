'use client'

// 桌面壳内的作战舱模式（2026-11-13，v4 重写 2026-11-15）：
// 原型里「新建作战舱 / 打开作战舱」都不改路由——左栏不动，对话区换成
// 新建页（CabinCreateHero）或该舱的 chat。这里把这份状态提到 AppShell 层：
//   · activeCabinId：当前在桌面里打开的舱（null = 普通对话）
//   · draft：正在新建的那份草稿（名字/目录/项目/需求）
//   · draftOpen：右页当前是不是新建页
//
// v4 的关键差别（plan §5.1）：`draft` 与 `draftOpen` 拆开。
//   · 走开（openCabin / closeDraft）只关右页，草稿还在 —— 回来接着填；
//   · cancelDraft 才把草稿丢掉（左栏草稿行消失，零请求）。
// 草稿落 localStorage（24h 过期），刷新后左栏仍有「未命名舱 · 草稿中」。
//
// activeCabinId 同样落 localStorage：刷新后回到同一个舱。

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  emptyCabinDraft,
  readCabinDraft,
  writeCabinDraft,
  type CabinDraft,
} from '@/lib/cabin-draft'

const ACTIVE_CABIN_KEY = 'octopus.cabin.active.v1'

export interface CabinModeValue {
  activeCabinId: string | null
  /** 新建草稿；null = 没有草稿（左栏不显示草稿行）。 */
  draft: CabinDraft | null
  /** 右页当前是否停留在新建页。 */
  draftOpen: boolean
  /** @deprecated `draftOpen` 的旧名字，仍供老外壳/单测读取。 */
  drafting: boolean
  openCabin: (id: string) => void
  startDraft: () => void
  updateDraft: (patch: Partial<CabinDraft>) => void
  /** 走开：只关右页，草稿留着。 */
  closeDraft: () => void
  /** 丢弃草稿（左栏行消失、零请求）。 */
  cancelDraft: () => void
  exitCabin: () => void
}

const NOOP = () => {}

/** 独立渲染（单测 / 故事）没有 provider 时保持普通对话，不抛错。 */
const FALLBACK: CabinModeValue = {
  activeCabinId: null,
  draft: null,
  draftOpen: false,
  drafting: false,
  openCabin: NOOP,
  startDraft: NOOP,
  updateDraft: NOOP,
  closeDraft: NOOP,
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
  // 刷新后草稿还在（左栏一行），但不自动把右页抢过去。
  const [draft, setDraft] = useState<CabinDraft | null>(readCabinDraft)
  const [draftOpen, setDraftOpen] = useState(false)

  const openCabin = useCallback((id: string) => {
    // 只关右页：草稿留着，回来还能接着填（I7）。
    setDraftOpen(false)
    setActiveCabinId(id)
    writeActiveCabin(id)
  }, [])

  const startDraft = useCallback(() => {
    // 原型 newCabin()：新建期间不在任何舱里；已有一份草稿就接着用。
    setActiveCabinId(null)
    writeActiveCabin(null)
    setDraft((current) => current ?? emptyCabinDraft())
    setDraftOpen(true)
  }, [])

  const updateDraft = useCallback((patch: Partial<CabinDraft>) => {
    setDraft((current) => {
      const base = current ?? emptyCabinDraft()
      const next: CabinDraft = { ...base, ...patch, updatedAt: Date.now() }
      writeCabinDraft(next)
      return next
    })
  }, [])

  const closeDraft = useCallback(() => setDraftOpen(false), [])

  const cancelDraft = useCallback(() => {
    setDraft(null)
    setDraftOpen(false)
    writeCabinDraft(null)
  }, [])

  const exitCabin = useCallback(() => {
    setActiveCabinId(null)
    writeActiveCabin(null)
  }, [])

  const value = useMemo<CabinModeValue>(
    () => ({
      activeCabinId, draft, draftOpen, drafting: draftOpen,
      openCabin, startDraft, updateDraft, closeDraft, cancelDraft, exitCabin,
    }),
    [activeCabinId, draft, draftOpen, openCabin, startDraft, updateDraft, closeDraft, cancelDraft, exitCabin],
  )

  return <CabinModeContext.Provider value={value}>{children}</CabinModeContext.Provider>
}

export function useCabinMode(): CabinModeValue {
  return useContext(CabinModeContext) ?? FALLBACK
}