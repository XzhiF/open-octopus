import type { LucideIcon } from "lucide-react"
import {
  BrainCircuit,
  Clock,
  FolderKanban,
  LayoutDashboard,
  Library,
  ListTodo,
  MessageSquare,
  Package,
  Settings,
  Sliders,
} from "lucide-react"

export interface NavItem {
  name: string
  href: string
  icon: LucideIcon
  /** Extra path prefix that should also mark this item active (e.g. /system). */
  activePrefix?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "工作",
    items: [
      { name: "对话", href: "/", icon: MessageSquare },
      { name: "今日", href: "/dashboard", icon: LayoutDashboard },
      { name: "任务看板", href: "/tasks", icon: ListTodo },
      { name: "工作空间", href: "/workspaces", icon: FolderKanban },
      { name: "Agent", href: "/agent", icon: BrainCircuit },
    ],
  },
  {
    label: "资产",
    items: [
      { name: "知识中心", href: "/knowledge", icon: Library },
      { name: "资源", href: "/resources", icon: Package },
      { name: "系统调度", href: "/scheduler", icon: Clock },
    ],
  },
  {
    label: "系统",
    items: [
      { name: "系统管理", href: "/system/models", icon: Sliders, activePrefix: "/system" },
      { name: "设置", href: "/settings", icon: Settings },
    ],
  },
]

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items)

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/") return pathname === "/"
  const prefix = item.activePrefix ?? item.href
  return pathname === item.href || pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function findNavItem(pathname: string): NavItem | undefined {
  return [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => isNavItemActive(pathname, item))
}
