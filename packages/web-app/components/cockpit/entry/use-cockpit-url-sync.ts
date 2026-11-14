'use client'

// selection/tab 单向同步到 URL（S1 建，S9 补默认选中 / 无效 ref 回退）。
//
// 挂载时把深链参数读进 state 一次（bootstrap），之后 state → URL 只写一次方向。
// 用 hydrated 状态而不是 ref：首帧的写回必须等 bootstrap 的 state 更新提交后
// 再跑，否则会把 ?job=… 用空选中覆盖掉。
//
// S9 规则（plans §1.3 / §1.1）：
//   · 无 ref 且编队**首次加载完成**后 → 默认选中（need 优先级降序 → run → queue）。
//     只做一次：之后用户按 ⌥2 / ✕ 收面（select(null)）不会被自动弹回来。
//   · ?job / ?task / ?attn 在全部 rows 里找不到（含跨舱行）且 rows 已加载过至少
//     一次 → 落默认选中；编队为空则收面（select(null)）。
//   · 跨舱 ref（?cabin=）本来就是合法行，不重绑聊天（聊天始终绑入口舱）。
//
// rows 的「加载过至少一次」用 counts !== null 判定（FleetProvider 的契约：
// null = 还没接过真值，不是空编队）。

import { useEffect, useRef, useState } from 'react'
import { useAppNavigation } from '@/lib/app-navigation'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { candidatesOf, refInRows } from './cockpit-candidates'
import { cockpitHrefPreserving, parseCockpitUrl, resolveDefaultRef } from './cockpit-url'

export function CockpitUrlSync() {
  const nav = useAppNavigation()
  const { entryCabinId, selection, tab, select } = useCockpitState()
  const { rows, counts } = useCockpitFleet()
  const [hydrated, setHydrated] = useState(false)
  const loadedOnce = counts !== null
  // 默认选中只落一次；无效 ref 回退可以反复发生（作业结束被移出编队时）。
  const defaultSettledRef = useRef(false)

  useEffect(() => {
    if (hydrated || !nav) return
    const parsed = parseCockpitUrl(nav.searchParams, entryCabinId)
    if (parsed.ref) select(parsed.ref, parsed.tab ?? undefined)
    else if (parsed.tab) select(null, parsed.tab)
    setHydrated(true)
  }, [hydrated, nav, entryCabinId, select])

  // 默认选中：只在首次加载完成后的一次。深链带了有效 ref 时这里不动
  // （只把 defaultSettled 标记掉，避免以后收面又被弹回来）。
  useEffect(() => {
    if (!hydrated || !loadedOnce) return
    if (defaultSettledRef.current) return
    defaultSettledRef.current = true
    if (selection) return
    const fallback = resolveDefaultRef(candidatesOf(rows))
    if (fallback) select(fallback)
  }, [hydrated, loadedOnce, selection, rows, select])

  // 无效 ref 回退：跨舱行也在 rows 里；merged attention 命中 job 行时也算有效。
  useEffect(() => {
    if (!hydrated || !loadedOnce || !selection) return
    if (refInRows(selection, rows)) return
    select(resolveDefaultRef(candidatesOf(rows)))
  }, [hydrated, loadedOnce, selection, rows, select])

  useEffect(() => {
    if (!hydrated || !nav) return
    // 只重写座舱自己的参数，保留调用方的（?demo=1 等）——否则演示门禁会被
    // 水合后的第一次 replace 抹掉。
    const href = cockpitHrefPreserving(entryCabinId, selection, tab, nav.searchParams)
    const search = nav.searchParams.toString()
    const current = search ? `${nav.pathname}?${search}` : nav.pathname
    if (current !== href) nav.router.replace(href)
  }, [hydrated, nav, entryCabinId, selection, tab])

  return null
}
