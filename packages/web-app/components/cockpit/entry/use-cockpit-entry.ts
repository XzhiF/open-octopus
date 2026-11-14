'use client'

// 入口/出口（S1 建最小版，S9 接管并补齐规则）。
//
// 入口（plans §1.2）：
//   · classic 舱壳右上角的「⛶ 全域」按钮 → enterCockpit（唯一入口）；
//     编队行点击保持 classic 原行为（作业详情窗），不在这里改道；
//   · 进入用 push（浏览器后退能回到进入前的位置）；
//   · origin 只在**非** /cockpit 路径时写 —— 全域内部再点入口不会把自己当返回目标。
//
// 出口（plans §1.4）：
//   · 有 origin（从桌面 / 舱内进来的）→ 回原路径，桌面与窗口原样恢复；
//     （CabinModeProvider 在 ShellBody 之上，回到原路径即可恢复桌面）
//   · 直接深链进来的 → /cabin/:entryCabinId；
//   · origin 存 sessionStorage['octopus.cockpit.origin']，返回时消费一次后清除。

import { useCallback } from 'react'
import type { CockpitRef, CockpitTab } from '../state/cockpit-state'
import { COCKPIT_PATH_SUFFIX, serializeCockpitHref } from './cockpit-url'
import { useOptionalAppNavigation } from './safe-navigation'

export const COCKPIT_ORIGIN_KEY = 'octopus.cockpit.origin'

export interface EnterCockpitInput {
  cabinId: string
  ref?: CockpitRef | null
  tab?: CockpitTab
}

export function cockpitHref(input: EnterCockpitInput): string {
  return serializeCockpitHref(input.cabinId, input.ref ?? null, input.tab)
}

/** 当前路径是不是全域座舱（尾斜杠也算）。 */
export function isCockpitPathname(pathname: string): boolean {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed.endsWith(COCKPIT_PATH_SUFFIX)
}

/** 只接受站内绝对路径，且不能又指回 /cockpit（否则返回会原地打转）。 */
function isReturnableOrigin(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !isCockpitPathname(href.split('?')[0] ?? '')
}

export function readCockpitOrigin(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const href = window.sessionStorage.getItem(COCKPIT_ORIGIN_KEY)
    return href && isReturnableOrigin(href) ? href : null
  } catch {
    return null
  }
}

export function writeCockpitOrigin(href: string): void {
  if (typeof window === 'undefined') return
  if (!isReturnableOrigin(href)) return
  try {
    window.sessionStorage.setItem(COCKPIT_ORIGIN_KEY, href)
  } catch {
    /* 隐私模式/配额满了：出口退化为 /cabin/:id */
  }
}

export function consumeCockpitOrigin(): string | null {
  const href = readCockpitOrigin()
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(COCKPIT_ORIGIN_KEY)
    } catch {
      /* ignore */
    }
  }
  return href
}

export interface CockpitEntryApi {
  enterCockpit(input: EnterCockpitInput): void
  exitCockpit(entryCabinId: string): void
  readOrigin(): string | null
}

export function useCockpitEntry(): CockpitEntryApi {
  const nav = useOptionalAppNavigation()

  const enterCockpit = useCallback(
    (input: EnterCockpitInput) => {
      if (!nav) return
      // 全域内部再点入口不算 origin（不会把自己当返回目标）。
      if (!isCockpitPathname(nav.pathname)) {
        const search = nav.searchParams.toString()
        writeCockpitOrigin(search ? `${nav.pathname}?${search}` : nav.pathname)
      }
      nav.router.push(cockpitHref(input))
    },
    [nav],
  )

  const exitCockpit = useCallback(
    (entryCabinId: string) => {
      const origin = consumeCockpitOrigin()
      nav?.router.push(origin ?? cockpitExitFallback(entryCabinId))
    },
    [nav],
  )

  return { enterCockpit, exitCockpit, readOrigin: readCockpitOrigin }
}

function cockpitExitFallback(entryCabinId: string): string {
  return entryCabinId ? `/cabin/${encodeURIComponent(entryCabinId)}` : '/'
}
