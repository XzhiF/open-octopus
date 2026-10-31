"use client"

import { useSyncExternalStore } from "react"
import { getDockLabelsVisible, subscribeDockLabels } from "@/lib/ui-preferences"

/**
 * 作业坞是否在图标下方常驻显示文字标签。
 * 默认 true；设置 → 外观 可切换，已打开的坞会立刻跟着变。
 */
export function useDockLabelsVisible(): boolean {
  return useSyncExternalStore(subscribeDockLabels, getDockLabelsVisible, () => true)
}
