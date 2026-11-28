"use client"

import { useSyncExternalStore } from "react"
import { getChatImageThumbs, subscribeChatImageThumbs } from "@/lib/ui-preferences"

/**
 * 对话里是否把图片绝对路径渲染成缩略图。
 * 默认 true；设置 → 外观 可切换，已打开的对话会立刻跟着变。
 */
export function useChatImageThumbs(): boolean {
  return useSyncExternalStore(subscribeChatImageThumbs, getChatImageThumbs, () => true)
}
