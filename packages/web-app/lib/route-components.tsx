import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { AppRoute, ViewId } from '@/lib/routes'

type LazyPage = LazyExoticComponent<ComponentType>

export const VIEW_COMPONENTS: Record<Exclude<ViewId, 'chat'>, LazyPage> = {
  dashboard: lazy(() => import('@/app/dashboard/page')),
  tasks: lazy(() => import('@/app/tasks/page')),
  workspaces: lazy(() => import('@/app/workspaces/page')),
  agent: lazy(() =>
    import('@/components/agent/layout/AgentLayout').then((m) => ({ default: m.AgentLayout })),
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
  workspace: lazy(() => import('@/app/workspaces/[id]/page')),
  'archive-detail': lazy(() => import('@/app/workspaces/[id]/archive-detail/page')),
  observability: lazy(() =>
    import('@/app/workspaces/[id]/executions/[eid]/observability/page'),
  ),
  resource: lazy(() => import('@/components/shell/resource-detail-route')),
  'scheduler-job': lazy(() => import('@/app/scheduler/jobs/[id]/page')),
}

export const STANDALONE_COMPONENTS: Record<string, LazyPage> = {
  'dev-agent-node': lazy(() => import('@/app/dev/agent-node-test/page')),
  'dev-harness': lazy(() => import('@/app/dev/harness-test/page')),
  'dev-moa': lazy(() => import('@/app/dev/moa-test/page')),
  'dev-swarm': lazy(() => import('@/app/dev/swarm-test/page')),
}

export function componentForRoute(route: AppRoute): LazyPage | null {
  if (route.kind === 'view') {
    if (route.view === 'chat') return null
    return VIEW_COMPONENTS[route.view] ?? null
  }
  if (route.kind === 'detail') return DETAIL_COMPONENTS[route.componentKey] ?? null
  if (route.kind === 'standalone') return STANDALONE_COMPONENTS[route.componentKey] ?? null
  return null
}
