import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { AppRoute, ViewId } from '@/lib/routes'
import { useParams } from '@/lib/app-navigation'

type LazyPage = LazyExoticComponent<ComponentType>

export const VIEW_COMPONENTS: Record<Exclude<ViewId, 'chat'>, LazyPage> = {
  dashboard: lazy(() => import('@/app/dashboard/page')),
  tasks: lazy(() => import('@/app/tasks/page')),
  agent: lazy(() =>
    import('@/components/agent/layout/AgentLayout').then((m) => ({ default: m.AgentLayout })),
  ),
  clones: lazy(() =>
    import('@/components/agent/clone/ClonesLayout').then((m) => ({ default: m.ClonesLayout })),
  ),
  knowledge: lazy(() => import('@/app/knowledge/page')),
  resources: lazy(() =>
    import('@/components/shell/resources-view').then((m) => ({ default: m.ResourcesView })),
  ),
  scheduler: lazy(() => import('@/app/scheduler/page')),
  system: lazy(() =>
    import('@/components/shell/system-view').then((m) => ({ default: m.SystemView })),
  ),
  settings: lazy(() =>
    import('@/components/shell/settings-view').then((m) => ({ default: m.SettingsView })),
  ),
}

export const DETAIL_COMPONENTS: Record<string, LazyPage> = {
  resource: lazy(() => import('@/components/shell/resource-detail-route')),
  'scheduler-job': lazy(() => import('@/app/scheduler/jobs/[id]/page')),
}

export const STANDALONE_COMPONENTS: Record<string, LazyPage> = {
  'dev-agent-node': lazy(() => import('@/app/dev/agent-node-test/page')),
  'dev-moa': lazy(() => import('@/app/dev/moa-test/page')),
  'dev-swarm': lazy(() => import('@/app/dev/swarm-test/page')),
}

const LazyCabinShell = lazy(() =>
  import('@/components/cabin/CabinShell').then((m) => ({ default: m.CabinShell })),
)

const LazyCockpitShell = lazy(() =>
  import('@/components/cockpit/shell/CockpitShell').then((m) => ({ default: m.CockpitShell })),
)

/** 舱壳路由入口：从路由参数取 cabinId（'new' = 新建向导）。 */
export function CabinShellRoute() {
  const params = useParams()
  return <LazyCabinShell cabinId={params.cabinId ?? ''} />
}

/** 全域座舱路由入口：cabinId 是入口舱（聊天/返回都锚在它上面）。 */
export function CabinCockpitRoute() {
  const params = useParams()
  return <LazyCockpitShell cabinId={params.cabinId ?? ''} />
}

/** 按 route.componentKey 分发（ShellBody 只认这张表，不再按 kind 一刀切）。 */
export const CABIN_COMPONENTS: Record<string, LazyPage> = {
  'cabin-shell': lazy(() => Promise.resolve({ default: CabinShellRoute })),
  'cabin-cockpit': lazy(() => Promise.resolve({ default: CabinCockpitRoute })),
}

export function componentForRoute(route: AppRoute): LazyPage | null {
  if (route.kind === 'view') {
    if (route.view === 'chat') return null
    return VIEW_COMPONENTS[route.view] ?? null
  }
  if (route.kind === 'detail') return DETAIL_COMPONENTS[route.componentKey] ?? null
  if (route.kind === 'standalone') return STANDALONE_COMPONENTS[route.componentKey] ?? null
  if (route.kind === 'cabin') return CABIN_COMPONENTS[route.componentKey] ?? null
  return null
}
