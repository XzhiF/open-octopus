"use client"

import { useEffect, useState } from "react"
import { usePathname } from "@/lib/app-navigation"
import { findNavItem } from "@/components/layout/nav-config"

export interface NavHistoryEntry {
  href: string
  label: string
  sub: string
}

const MAX_STORED = 12
const MAX_VISIBLE = 4

/**
 * Session-only MRU of visited pages. Lives in the app shell, so it survives
 * client-side navigation but intentionally resets on reload. The conversation
 * home ("/") is recorded too — 作业坞导航需要常驻「对话」入口。
 */
export function useNavHistory() {
  const pathname = usePathname()
  const [entries, setEntries] = useState<NavHistoryEntry[]>([])

  useEffect(() => {
    if (!pathname) return
    const item = findNavItem(pathname)
    const entry: NavHistoryEntry = {
      href: pathname,
      label: item?.name ?? "页面",
      sub: pathname,
    }
    setEntries((previous) => {
      if (previous[0]?.href === pathname) return previous
      return [entry, ...previous.filter((existing) => existing.href !== pathname)].slice(
        0,
        MAX_STORED,
      )
    })
  }, [pathname])

  const remove = (href: string) => {
    setEntries((previous) => previous.filter((entry) => entry.href !== href))
  }

  return {
    entries: entries.slice(0, MAX_VISIBLE),
    total: entries.length,
    remove,
  }
}
