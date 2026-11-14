// S9 —— 对 @/lib/app-navigation 的「可选」访问。
//
// 背景：旧舱测试（components/cabin/__tests__/CabinChatHost.test.tsx）对这个模块
// 做了**部分 mock**（只返回 useRouter）。Vitest 的 mock 在访问缺失导出时会直接抛错，
// 而 CabinChatHost 的「⛶ 全域」入口 / CockpitShortcuts 要读壳导航（origin / active
// 守卫）才能工作。
//
// 这里在模块初始化时探测一次：导出存在就用真 hook，缺失就退化为
// 「没有壳导航 / 视为激活」。生产代码里导出永远存在；只有部分 mock 的测试走退化分支。
// 探测包在 try/catch 里——Vitest 的 mock proxy 对缺失属性会抛，而不是返回 undefined。

import * as appNavigation from '@/lib/app-navigation'
import type { AppNavigationValue } from '@/lib/app-navigation'

type NavigationHook = () => AppNavigationValue | null
type ActiveHook = () => boolean

function pickHook<T>(name: string, fallback: T): T {
  try {
    const value = (appNavigation as unknown as Record<string, unknown>)[name]
    return typeof value === 'function' ? (value as T) : fallback
  } catch {
    return fallback
  }
}

const useAppNavigationSafe: NavigationHook = pickHook('useAppNavigation', () => null)
const useIsActiveRouteSafe: ActiveHook = pickHook('useIsActiveRoute', () => true)

/** 壳导航；没有 Provider / 模块被部分 mock 时为 null。 */
export function useOptionalAppNavigation(): AppNavigationValue | null {
  return useAppNavigationSafe()
}

/** 隐藏窗口 / 后台标签守卫；导航不可用时视为激活（与 useIsActiveRoute 默认一致）。 */
export function useOptionalIsActiveRoute(): boolean {
  return useIsActiveRouteSafe()
}
