// Pure geometry for the in-app window manager. No React, no DOM.

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const HEADER_HEIGHT = 32
export const TITLE_BAR_HEIGHT = 36
export const MIN_WINDOW_WIDTH = 480
export const MIN_WINDOW_HEIGHT = 320
export const CASCADE_STEP = 24
export const MIN_VISIBLE_TITLE = 160

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** The stage is the area below the global header; window coordinates are relative to it. */
export function stageSize(viewport: Size): Size {
  return {
    width: Math.max(1, viewport.width),
    height: Math.max(1, viewport.height - HEADER_HEIGHT),
  }
}

export function clampRect(rect: Rect, stage: Size): Rect {
  const maxW = Math.max(1, stage.width)
  const maxH = Math.max(1, stage.height)
  const minW = Math.min(MIN_WINDOW_WIDTH, maxW)
  const minH = Math.min(MIN_WINDOW_HEIGHT, maxH)
  const w = clamp(rect.w, minW, maxW)
  const h = clamp(rect.h, minH, maxH)

  const visible = Math.min(MIN_VISIBLE_TITLE, w)
  const xMin = -w + visible
  const xMax = Math.max(xMin, stage.width - visible)
  const yMin = 0
  const yMax = Math.max(yMin, stage.height - TITLE_BAR_HEIGHT)

  return {
    x: clamp(rect.x, xMin, xMax),
    y: clamp(rect.y, yMin, yMax),
    w,
    h,
  }
}

export interface PreferredSize {
  width?: number
  height?: number
}

export function cascadeRect(stage: Size, index: number, preferred?: PreferredSize): Rect {
  const targetW = preferred?.width ?? Math.round(stage.width * 0.72)
  const targetH = preferred?.height ?? Math.round(stage.height * 0.72)
  const w = clamp(
    targetW,
    Math.min(MIN_WINDOW_WIDTH, stage.width),
    Math.min(1280, stage.width),
  )
  const h = clamp(
    targetH,
    Math.min(MIN_WINDOW_HEIGHT, stage.height),
    Math.min(860, stage.height),
  )
  const offset = (Math.max(0, index) % 6) * CASCADE_STEP
  return clampRect(
    {
      x: Math.round((stage.width - w) / 2) + offset,
      y: Math.round((stage.height - h) / 2) + offset,
      w,
      h,
    },
    stage,
  )
}

export function maximizeRect(stage: Size): Rect {
  return { x: 0, y: 0, w: Math.max(1, stage.width), h: Math.max(1, stage.height) }
}

export function resizeRect(
  start: Rect,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  stage: Size,
): Rect {
  const minW = Math.min(MIN_WINDOW_WIDTH, stage.width)
  const minH = Math.min(MIN_WINDOW_HEIGHT, stage.height)
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h

  if (direction.includes('w')) {
    left = clamp(start.x + dx, 0, right - minW)
  }
  if (direction.includes('e')) {
    right = clamp(start.x + start.w + dx, left + minW, stage.width)
  }
  if (direction.includes('n')) {
    top = clamp(start.y + dy, 0, bottom - minH)
  }
  if (direction.includes('s')) {
    bottom = clamp(start.y + start.h + dy, top + minH, stage.height)
  }

  return { x: left, y: top, w: right - left, h: bottom - top }
}

export const MISSION_PADDING = 32
export const MISSION_GAP = 24
export const MISSION_CAPTION_HEIGHT = 28
export const MISSION_MAX_COLUMNS = 4

export interface MissionEntry {
  id: string
  rect: Rect
}

export interface MissionSlot {
  id: string
  /** Where the scaled window content sits. */
  content: Rect
  /** Full cell including caption space. */
  tile: Rect
  /** Caption strip below the content. */
  caption: Rect
  scale: number
  /** Stage-space translation of the scaled content. */
  tx: number
  ty: number
}

export function missionLayout(entries: MissionEntry[], stage: Size): MissionSlot[] {
  const count = entries.length
  if (count === 0) return []

  const width = Math.max(1, stage.width)
  const height = Math.max(1, stage.height)
  const cols = Math.min(
    count,
    MISSION_MAX_COLUMNS,
    Math.max(1, Math.ceil(Math.sqrt(count))),
  )
  const rows = Math.ceil(count / cols)
  const padding = Math.min(MISSION_PADDING, width / 8, height / 8)
  const gap = Math.min(MISSION_GAP, width / 16, height / 16)
  const captionHeight = Math.min(MISSION_CAPTION_HEIGHT, height / 16)
  const cellW = Math.max(40, (width - padding * 2 - gap * (cols - 1)) / cols)
  const rowH = Math.max(40, (height - padding * 2 - gap * (rows - 1)) / rows)
  const contentH = Math.max(24, rowH - captionHeight)

  return entries.map((entry, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const x = padding + col * (cellW + gap)
    const y = padding + row * (rowH + gap)
    const content: Rect = { x, y, w: cellW, h: contentH }
    const sourceW = Math.max(1, entry.rect.w)
    const sourceH = Math.max(1, entry.rect.h)
    const scale = Math.min(content.w / sourceW, content.h / sourceH, 1)
    return {
      id: entry.id,
      content,
      tile: { x, y, w: cellW, h: rowH },
      caption: {
        x,
        y: y + contentH + 4,
        w: cellW,
        h: Math.max(14, captionHeight - 4),
      },
      scale,
      tx: content.x + (content.w - sourceW * scale) / 2,
      ty: content.y + (content.h - sourceH * scale) / 2,
    }
  })
}
