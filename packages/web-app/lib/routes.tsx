import { matchPath } from 'react-router-dom'
import { retiredRedirectTarget } from './retired-redirects'

export type ViewId =
  | 'chat'
  | 'dashboard'
  | 'tasks'
  | 'workspaces'
  | 'agent'
  | 'knowledge'
  | 'resources'
  | 'scheduler'
  | 'system'
  | 'settings'

export type RouteKind = 'view' | 'detail' | 'redirect' | 'standalone' | 'not-found'
export type RouteParams = Record<string, string>

export interface ViewRoute {
  kind: 'view'
  id: string
  path: string
  view: ViewId
  title: string
}

export interface DetailRoute {
  kind: 'detail'
  id: string
  path: string
  componentKey: string
  title: (params: RouteParams) => string
  key: (params: RouteParams) => string
  ownerView: ViewId
  fallback: (params: RouteParams) => string
  panel: 'scroll' | 'contained'
}

export interface RedirectRoute {
  kind: 'redirect'
  id: string
  path: string
  to: string | ((params: RouteParams) => string)
}

export interface StandaloneRoute {
  kind: 'standalone'
  id: string
  path: string
  componentKey: string
  title: string
}

export interface NotFoundRoute {
  kind: 'not-found'
  id: 'not-found'
  path: '*'
  title: string
}

export type AppRoute = ViewRoute | DetailRoute | RedirectRoute | StandaloneRoute | NotFoundRoute

export interface RouteMatch {
  route: AppRoute
  params: RouteParams
}

export const NOT_FOUND_ROUTE: NotFoundRoute = {
  kind: 'not-found',
  id: 'not-found',
  path: '*',
  title: '未找到',
}

const VIEW_ROUTES: ViewRoute[] = [
  { kind: 'view', id: 'chat', path: '/', view: 'chat', title: '对话' },
  { kind: 'view', id: 'dashboard', path: '/dashboard', view: 'dashboard', title: '今日' },
  { kind: 'view', id: 'tasks', path: '/tasks', view: 'tasks', title: '任务看板' },
  { kind: 'view', id: 'workspaces', path: '/workspaces', view: 'workspaces', title: '工作空间' },
  { kind: 'view', id: 'agent', path: '/agent', view: 'agent', title: 'Agent' },
  { kind: 'view', id: 'knowledge', path: '/knowledge', view: 'knowledge', title: '知识中心' },
  { kind: 'view', id: 'resources', path: '/resources', view: 'resources', title: '资源' },
  { kind: 'view', id: 'scheduler', path: '/scheduler', view: 'scheduler', title: '系统调度' },
  { kind: 'view', id: 'settings', path: '/settings', view: 'settings', title: '设置' },
  { kind: 'view', id: 'system-models', path: '/system/models', view: 'system', title: '系统管理' },
  { kind: 'view', id: 'system-billing', path: '/system/billing', view: 'system', title: '系统管理' },
  { kind: 'view', id: 'system-repos', path: '/system/repos', view: 'system', title: '系统管理' },
  { kind: 'view', id: 'system-harness', path: '/system/harness', view: 'system', title: '系统管理' },
]

const DETAIL_ROUTES: DetailRoute[] = [
  {
    kind: 'detail',
    id: 'observability',
    path: '/workspaces/:id/executions/:eid/observability',
    componentKey: 'observability',
    title: (params) => `运行观测 · ${shortId(params.eid)}`,
    key: (params) => `observability:${params.id}:${params.eid}`,
    ownerView: 'workspaces',
    fallback: (params) => `/workspaces/${encodeURIComponent(params.id)}`,
    panel: 'scroll',
  },
  {
    kind: 'detail',
    id: 'archive-detail',
    path: '/workspaces/:id/archive-detail',
    componentKey: 'archive-detail',
    title: (params) => `归档 · ${shortId(params.id)}`,
    key: (params) => `archive:${params.id}`,
    ownerView: 'workspaces',
    fallback: () => '/workspaces',
    panel: 'scroll',
  },
  {
    kind: 'detail',
    id: 'workspace',
    path: '/workspaces/:id',
    componentKey: 'workspace',
    title: (params) => `工作空间 · ${shortId(params.id)}`,
    key: (params) => `workspace:${params.id}`,
    ownerView: 'workspaces',
    fallback: () => '/workspaces',
    panel: 'contained',
  },
  {
    kind: 'detail',
    id: 'resource',
    path: '/resources/:type/:name',
    componentKey: 'resource',
    title: (params) => `${params.type ?? '资源'} / ${shortId(params.name)}`,
    key: (params) => `resource:${params.type}:${params.name}`,
    ownerView: 'resources',
    fallback: () => '/resources?tab=list',
    panel: 'scroll',
  },
  {
    kind: 'detail',
    id: 'scheduler-job',
    path: '/scheduler/jobs/:id',
    componentKey: 'scheduler-job',
    title: (params) => `调度作业 · ${shortId(params.id)}`,
    key: (params) => `job:${params.id}`,
    ownerView: 'scheduler',
    fallback: () => '/scheduler',
    panel: 'scroll',
  },
]

const REDIRECT_ROUTES: RedirectRoute[] = [
  { kind: 'redirect', id: 'system', path: '/system', to: '/system/models' },
  { kind: 'redirect', id: 'resources-audit', path: '/resources/audit', to: '/resources?tab=audit' },
  { kind: 'redirect', id: 'resources-install', path: '/resources/install', to: '/resources' },
]

const STANDALONE_ROUTES: StandaloneRoute[] = [
  { kind: 'standalone', id: 'dev-agent-node', path: '/dev/agent-node-test', componentKey: 'dev-agent-node', title: 'Agent Node Test' },
  { kind: 'standalone', id: 'dev-harness', path: '/dev/harness-test', componentKey: 'dev-harness', title: 'Harness Test' },
  { kind: 'standalone', id: 'dev-moa', path: '/dev/moa-test', componentKey: 'dev-moa', title: 'MoA Test' },
  { kind: 'standalone', id: 'dev-swarm', path: '/dev/swarm-test', componentKey: 'dev-swarm', title: 'Swarm Test' },
]

/** 顺序即优先级：redirect → 长详情 → 短详情 → 视图 → standalone。 */
const ROUTES: AppRoute[] = [
  ...REDIRECT_ROUTES,
  ...DETAIL_ROUTES,
  ...VIEW_ROUTES,
  ...STANDALONE_ROUTES,
]

export function normalizePathname(pathname: string): string {
  if (!pathname) return '/'
  const withoutQuery = pathname.split('?')[0] ?? pathname
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.replace(/\/+$/, '') || '/'
  }
  return withoutQuery
}

export function matchAppRoute(pathname: string): RouteMatch {
  const path = normalizePathname(pathname)
  const retired = retiredRedirectTarget(path)
  if (retired) {
    return {
      route: { kind: 'redirect', id: 'retired', path, to: retired },
      params: {},
    }
  }

  for (const route of ROUTES) {
    const match = matchPath({ path: route.path, end: true }, path)
    if (match) {
      return { route, params: (match.params ?? {}) as RouteParams }
    }
  }

  return { route: NOT_FOUND_ROUTE, params: {} }
}

export function isAppViewPath(pathname: string): boolean {
  return matchAppRoute(pathname).route.kind === 'view'
}

export function viewIdFromPath(pathname: string): ViewId | null {
  const { route } = matchAppRoute(pathname)
  return route.kind === 'view' ? route.view : null
}

export function titleForRoute(route: AppRoute, params: RouteParams): string {
  if (route.kind === 'detail') return route.title(params)
  if (route.kind === 'redirect') return '跳转中'
  return route.title
}

export function routeMode(route: AppRoute): Exclude<RouteKind, 'redirect'> | 'redirect' {
  return route.kind
}

function shortId(value: string | undefined): string {
  if (!value) return '?'
  const decoded = safeDecode(value)
  return decoded.length > 14 ? `${decoded.slice(0, 10)}…` : decoded
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
