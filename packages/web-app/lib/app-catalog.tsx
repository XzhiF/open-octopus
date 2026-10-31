import type { LucideIcon } from 'lucide-react'
import {
  BrainCircuit,
  Clock,
  FolderKanban,
  LayoutDashboard,
  Library,
  ListTodo,
  Package,
  Settings,
  Sliders,
} from 'lucide-react'
import type { ViewId } from './routes'

export type AppId = Exclude<ViewId, 'chat'>

export interface AppEntry {
  id: AppId
  label: string
  href: string
  icon: LucideIcon
  group: '工作' | '资产' | '系统'
  /** Preferred window size on a wide stage; falls back to the 72% cascade. */
  preferredWidth?: number
  preferredHeight?: number
}

const ENTRIES: AppEntry[] = [
  { id: 'dashboard', label: '今日', href: '/dashboard', icon: LayoutDashboard, group: '工作' },
  {
    id: 'tasks',
    label: '任务看板',
    href: '/tasks',
    icon: ListTodo,
    group: '工作',
    preferredWidth: 1240,
    preferredHeight: 760,
  },
  { id: 'workspaces', label: '工作空间', href: '/workspaces', icon: FolderKanban, group: '工作' },
  { id: 'agent', label: 'Agent', href: '/agent', icon: BrainCircuit, group: '工作' },
  { id: 'knowledge', label: '知识中心', href: '/knowledge', icon: Library, group: '资产' },
  { id: 'resources', label: '资源', href: '/resources', icon: Package, group: '资产' },
  { id: 'scheduler', label: '系统调度', href: '/scheduler', icon: Clock, group: '资产' },
  { id: 'system', label: '系统管理', href: '/system/models', icon: Sliders, group: '系统' },
  { id: 'settings', label: '设置', href: '/settings', icon: Settings, group: '系统' },
]

export const APP_GROUPS: Array<{ label: AppEntry['group']; apps: AppEntry[] }> = [
  { label: '工作', apps: ENTRIES.filter((entry) => entry.group === '工作') },
  { label: '资产', apps: ENTRIES.filter((entry) => entry.group === '资产') },
  { label: '系统', apps: ENTRIES.filter((entry) => entry.group === '系统') },
]

export const APP_CATALOG: Record<AppId, AppEntry> = ENTRIES.reduce(
  (acc, entry) => ({ ...acc, [entry.id]: entry }),
  {} as Record<AppId, AppEntry>,
)

const APP_IDS = new Set<string>(ENTRIES.map((entry) => entry.id))

export function isAppId(value: string): value is AppId {
  return APP_IDS.has(value)
}

export function appRootPath(id: AppId): string {
  return APP_CATALOG[id].href
}

export function appPreferredSize(
  id: AppId,
): { width?: number; height?: number } | undefined {
  const entry = APP_CATALOG[id]
  if (entry.preferredWidth == null && entry.preferredHeight == null) return undefined
  return { width: entry.preferredWidth, height: entry.preferredHeight }
}
