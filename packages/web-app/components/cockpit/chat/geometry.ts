// S5 owns this file —— 聊天浮窗的纯几何（无 React、无 DOM 读取）。
//
// 默认几何按 plans §0.3：
//   x = arena.left + scene.paddingLeft
//   y = arena.top
//   w = arena.width - paddingLeft
//   h = arena.height - 8
// 夹回 8px；mini 47px。
//
// 复用说明：`lib/window-geometry.ts` 的 `clampRect / resizeRect` 是**桌面窗口**
// 的最小尺寸（480 × 320，见该文件的 MIN_WINDOW_WIDTH/HEIGHT），聊天浮窗要能缩到
// 320 × 240（Step 5 手工验收项），所以这里复用它的 `Rect` 形状与夹回语义，但最小
// 尺寸按聊天浮窗自己的口径来 —— 不另写一套坐标/夹回算法，也不放宽桌面窗口。

import type { CockpitRect } from '../state/cockpit-state'
import type { Size } from '@/lib/window-geometry'

/** 聊天浮窗最小尺寸（可缩到 320 × 240）。 */
export const CHAT_MIN_WIDTH = 320
export const CHAT_MIN_HEIGHT = 240
/** 收起态（只剩标题栏）。 */
export const CHAT_MINI_HEIGHT = 47
/** 越界夹回留白。 */
export const CHAT_MARGIN = 8
/** v12 的「◍」五档不透明度（0–1，写进 --oa）。 */
export const CHAT_ALPHA_STEPS = [0.94, 0.82, 0.7, 0.55, 1] as const

export interface ArenaBox {
  left: number
  top: number
  width: number
  height: number
}

export type Viewport = Size

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 作业面让位宽度（v12 断点）：>1360 → 366，>900 → 334，否则 300。
 *  `.ck12-scene` 存在时由调用方直接读它的 paddingLeft，这里是兜底。 */
export function cockpitChatPadding(viewportWidth: number): number {
  if (viewportWidth > 1360) return 366
  if (viewportWidth > 900) return 334
  return 300
}

/** 默认几何：浮窗落在作业面的「场景区」（立绘右侧），不压立绘。 */
export function cockpitChatRect(arena: ArenaBox, paddingLeft: number): CockpitRect {
  const pad = Number.isFinite(paddingLeft) ? Math.max(0, Math.round(paddingLeft)) : 0
  return {
    x: Math.round(arena.left + pad),
    y: Math.round(arena.top),
    w: Math.max(CHAT_MIN_WIDTH, Math.round(arena.width - pad)),
    h: Math.max(CHAT_MINI_HEIGHT, Math.round(arena.height - CHAT_MARGIN)),
  }
}

/** 夹回视口（8px 留白），同时把尺寸夹进 [最小尺寸, 视口尺寸]。 */
export function clampCockpitRect(rect: CockpitRect, viewport: Viewport): CockpitRect {
  const vw = Math.max(1, Math.round(viewport.width))
  const vh = Math.max(1, Math.round(viewport.height))
  const maxW = Math.max(1, vw - CHAT_MARGIN * 2)
  const maxH = Math.max(1, vh - CHAT_MARGIN * 2)
  const minW = Math.min(CHAT_MIN_WIDTH, maxW)
  const minH = Math.min(CHAT_MIN_HEIGHT, maxH)

  const w = clamp(Math.round(rect.w), minW, maxW)
  const h = clamp(Math.round(rect.h), minH, maxH)
  const x = clamp(Math.round(rect.x), CHAT_MARGIN, Math.max(CHAT_MARGIN, vw - w - CHAT_MARGIN))
  const y = clamp(Math.round(rect.y), CHAT_MARGIN, Math.max(CHAT_MARGIN, vh - h - CHAT_MARGIN))
  return { x, y, w, h }
}

/** 收起 = 只剩标题栏（宽度/位置不变）。 */
export function miniCockpitRect(rect: CockpitRect): CockpitRect {
  return { ...rect, h: CHAT_MINI_HEIGHT }
}

/** 右下角拖拽缩放（只处理 e/s 方向，尺寸夹进最小值与视口）。 */
export function resizeCockpitRect(
  start: CockpitRect,
  delta: { dx: number; dy: number },
  viewport: Viewport,
): CockpitRect {
  const vw = Math.max(1, Math.round(viewport.width))
  const vh = Math.max(1, Math.round(viewport.height))
  const maxW = Math.max(CHAT_MIN_WIDTH, vw - start.x - CHAT_MARGIN)
  const maxH = Math.max(CHAT_MINI_HEIGHT, vh - start.y - CHAT_MARGIN)
  return {
    x: start.x,
    y: start.y,
    w: clamp(Math.round(start.w + delta.dx), Math.min(CHAT_MIN_WIDTH, maxW), maxW),
    h: clamp(
      Math.round(start.h + delta.dy),
      Math.min(start.h <= CHAT_MINI_HEIGHT ? CHAT_MINI_HEIGHT : CHAT_MIN_HEIGHT, maxH),
      maxH,
    ),
  }
}

/** 拖动标题栏后的位置夹回。 */
export function moveCockpitRect(
  start: CockpitRect,
  delta: { dx: number; dy: number },
  viewport: Viewport,
): CockpitRect {
  return clampCockpitRect({ ...start, x: start.x + delta.dx, y: start.y + delta.dy }, viewport)
}

/** v20（design 29 §5）左缘 grip：右缘钉住，x/w 反向联动。 */
export function resizeCockpitRectLeft(
  start: CockpitRect,
  delta: { dx: number; dy: number },
  viewport: Viewport,
): CockpitRect {
  const vw = Math.max(1, Math.round(viewport.width))
  const right = start.x + start.w
  const minX = CHAT_MARGIN
  const maxX = Math.max(minX, right - Math.min(CHAT_MIN_WIDTH, vw - CHAT_MARGIN * 2))
  const x = clamp(Math.round(start.x + delta.dx), minX, maxX)
  return { ...start, x, w: right - x }
}

/** v20 上缘 grip：底缘钉住，y/h 反向联动。 */
export function resizeCockpitRectTop(
  start: CockpitRect,
  delta: { dx: number; dy: number },
  viewport: Viewport,
): CockpitRect {
  const vh = Math.max(1, Math.round(viewport.height))
  const bottom = start.y + start.h
  const minY = CHAT_MARGIN
  const maxY = Math.max(minY, bottom - Math.min(CHAT_MIN_HEIGHT, vh - CHAT_MARGIN * 2))
  const y = clamp(Math.round(start.y + delta.dy), minY, maxY)
  return { ...start, y, h: bottom - y }
}

/** v20 弹出窗级联几何（design 29 §4）：x=120+n*64, y=84+n*34，夹回视口。 */
export function cascadeWinRect(index: number, viewport: Viewport): CockpitRect {
  const vw = Math.max(1, Math.round(viewport.width))
  const vh = Math.max(1, Math.round(viewport.height))
  const w = Math.min(380, vw - 24)
  const h = Math.min(440, vh - 140)
  const x = clamp(120 + index * 64, CHAT_MARGIN, Math.max(CHAT_MARGIN, vw - w - CHAT_MARGIN))
  const y = clamp(84 + index * 34, CHAT_MARGIN, Math.max(CHAT_MARGIN, vh - h - CHAT_MARGIN))
  return { x, y, w, h }
}

/** 五档循环：94 → 82 → 70 → 55 → 100 → 94 … */
export function nextCockpitAlpha(alpha: number): number {
  const index = CHAT_ALPHA_STEPS.findIndex((step) => Math.abs(step - alpha) < 0.005)
  if (index < 0) return CHAT_ALPHA_STEPS[0]
  return CHAT_ALPHA_STEPS[(index + 1) % CHAT_ALPHA_STEPS.length]
}

// ── v21（design 31 §2.1 / §5.4）：通讯台默认几何 ─────────────────────────
//
// 左缘 = 立绘右缘 − 22（贴住立绘、重叠 22px）；右缘让出右栏（--railr）；
// v22 起再整体左移 36（--ck12-charshift），让出的宽度全给通讯台 —— 与立绘左右
// 空隙对称，且不压左侧编队（原型 cockpit-v22.html .console）；
// top 66（HUD 54 + 12）；底部 = 视口 − 56（原型 844 @900），与底栏上沿严丝合缝
// —— 底栏（composer）视觉上就是通讯台的输入行（v21 ⑤A）。
// ≤900 变底部 sheet：左 52 / 右 92 / 高 56vh（≤560：左 46 / 右 80 / 52vh），
// 顶端 = 底栏上沿 − sheet，与原型「立绘从 sheet 上方探出」一致。

export interface ConsoleEnv {
  viewport: Viewport
  /** 底栏（.ck12-cmd）上沿；只在量不到 composer 时兜底。 */
  footerTop?: number | null
  /** composer 输入槽上沿：通讯台底缘直接贴它，保证「同一台」的无缝观感。 */
  composerTop?: number | null
}

export function cockpitConsoleRect({ viewport, footerTop, composerTop }: ConsoleEnv): CockpitRect {
  const vw = Math.max(1, Math.round(viewport.width))
  const vh = Math.max(1, Math.round(viewport.height))
  const railw = vw <= 1240 ? 64 : vw <= 1320 ? 186 : 198
  const railr = vw <= 560 ? 80 : vw <= 900 ? 92 : vw <= 1320 ? 104 : 100
  const charh = vh * (vw <= 560 ? 0.32 : vw <= 900 ? 0.34 : vw <= 1240 ? 0.66 : vw <= 1320 ? 0.7 : 0.74)
  const charw = (charh * 2) / 3
  /** v22：立绘左移量（与 base.css --ck12-charshift 同步）。 */
  const charshift = 36
  // 宽屏：底缘 = composer 上沿（量不到时按 视口 − 56 / 底栏上沿取小者）。
  // 窄屏：sheet 底缘同样让开 composer（底栏高度随断点变）。
  const fallback = Math.min(vh - 56, footerTop && footerTop > 0 ? Math.round(footerTop) : vh - 56)
  const bottom = composerTop && composerTop > 0 ? Math.round(composerTop) : fallback

  let left: number
  let top: number
  let height: number
  if (vw <= 900) {
    left = vw <= 560 ? 46 : 52
    const sheet = vh * (vw <= 560 ? 0.52 : 0.56)
    height = Math.max(CHAT_MIN_HEIGHT, Math.min(sheet, bottom - 66))
    top = Math.max(56, bottom - height)
  } else {
    left = Math.round(railw + 16 + charw - 22 - charshift)
    top = 66
    height = Math.max(CHAT_MIN_HEIGHT, bottom - top)
  }

  const width = Math.max(CHAT_MIN_WIDTH, vw - left - railr)
  return clampCockpitRect({ x: left, y: top, w: width, h: height }, viewport)
}
