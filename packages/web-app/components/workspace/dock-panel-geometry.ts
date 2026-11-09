// packages/web-app/components/workspace/dock-panel-geometry.ts
//
// 作业坞浮窗（文件列表 pane / 编辑器面板）的拖拽几何。
//
// 这两个框是「右侧锚定」的：东边贴着作业坞（或分屏线），宽度改的是西边。
// 之前复用弹窗的 DialogResizeHandles（为 fixed 居中的 Radix 弹窗写的）——
// 它把视口坐标写进 left/top，而这两个框的 offsetParent 是聊天栏而不是视口，
// 一抓边就整体跳位；且 left 被钉死后 React 继续改 right/width，调侧栏/分屏
// 宽度时框子会跟作业坞脱开（2026-11-09 用户反馈「调整宽度时文件内容框错位」）。
// 所以这里改成纯函数 + React 状态：拖动只算尺寸，位置永远由 right 锚定推导。

import type { ResizeDirection } from '@/lib/window-geometry'

/** 浮窗几何：宽高 + 相对 offsetParent 的上边距（右侧锚定，left 不参与）。 */
export interface PanelFrame {
  width: number
  height: number
  top: number
}

export interface PanelFrameLimits {
  minWidth: number
  minHeight: number
  /** 宽度上限 = 到容器左留白之间还能放下的宽度。 */
  maxWidth: number
  /** 容器可视高度（上沿 + 高度 + 下留白不越过它）。 */
  containerHeight: number
  /** 浮窗与容器底部的留白，缺省 8。 */
  bottomGap?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function maxHeightFor(limits: PanelFrameLimits, top: number): number {
  return Math.max(limits.minHeight, limits.containerHeight - top - (limits.bottomGap ?? 8))
}

/**
 * 拖拽中的新几何。只认西边（改宽）和南北边（改高）——东边固定贴着作业坞，
 * 边界拖拽交给文件列表 pane 自己的西边把手，两个框不会互相遮住。
 */
export function resizePanelFrame(
  start: PanelFrame,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  limits: PanelFrameLimits,
): PanelFrame {
  let width = start.width
  let height = start.height
  if (direction.includes('w')) width = start.width - dx
  if (direction.includes('n')) height = start.height - dy
  else if (direction.includes('s')) height = start.height + dy

  width = clamp(width, limits.minWidth, limits.maxWidth)
  // 拖北边时下沿是锚：最大高度不能越过原下沿，否则 top 会被推到负值。
  const maxHeight = direction.includes('n')
    ? Math.min(maxHeightFor(limits, 0), start.top + start.height)
    : maxHeightFor(limits, start.top)
  height = clamp(height, limits.minHeight, maxHeight)

  const top = direction.includes('n') ? start.top + start.height - height : start.top
  return { width: Math.round(width), height: Math.round(height), top: Math.round(top) }
}

/** 渲染时把用户拖过的尺寸夹回当前可用空间（侧栏变宽 / 分屏变窄 / 窗口缩小）。 */
export function fitPanelFrame(frame: PanelFrame, limits: PanelFrameLimits): PanelFrame {
  const width = clamp(frame.width, limits.minWidth, limits.maxWidth)
  const height = clamp(frame.height, limits.minHeight, maxHeightFor(limits, frame.top))
  const top = clamp(frame.top, 0, Math.max(0, limits.containerHeight - height - (limits.bottomGap ?? 8)))
  return { width: Math.round(width), height: Math.round(height), top: Math.round(top) }
}
