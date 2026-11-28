'use client'

// 聊天里的产物路径 → 打开只读文档窗（2026-11-19 全舱 / 2026-11-26 桌面）。
// 事件是全站单通道：全舱由 CockpitDocWindow 接，桌面 / 经典舱由 ChatDocWindow 接。
// sessionId 让桌面窗知道用哪个会话解析白名单（全舱窗不看它，走舱级 doc 接口）。

export const OPEN_DOC_EVENT = 'octopus:open-doc'

export interface OpenDocDetail {
  /** 文档绝对路径（盘符 / POSIX 根开头）。 */
  path: string
  /** 点开它的会话；缺省 = 宿主自己决定（全舱按 entryCabinId）。 */
  sessionId?: string | null
}

/** 任意宿主（聊天 chip / 后续其他入口）→ 打开文档窗。 */
export function openDoc(path: string, sessionId?: string | null): void {
  if (!path) return
  window.dispatchEvent(new CustomEvent<OpenDocDetail>(OPEN_DOC_EVENT, { detail: { path, sessionId } }))
}
