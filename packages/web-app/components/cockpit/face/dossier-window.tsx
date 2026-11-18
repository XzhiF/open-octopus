'use client'

// 详情 dossier 的窗口化能力（v21 五轮，原型 .pwin / bindPanelWin）：
// 面板由 CockpitFace 持有几何（拖拽 / 缩放 / 全屏），头部组件只拿一个开关
// 去画右上角的 ⛶ 按钮 —— 避免把几何状态逐个 prop 钻过 JobFace/TaskFace。
//
// 不在 dossier 里的头部（classic 作业窗等）没有 Provider → hook 返回 null，
// 不渲染按钮，行为完全不变。

import { createContext, useContext } from 'react'

export interface DossierWindowApi {
  /** 是否全屏（原型 state.panelMax）。 */
  maximized: boolean
  /** 全屏 / 还原（原型 togglePanelMax；双击标题栏同一动作）。 */
  toggleMax(): void
}

export const DossierWindowContext = createContext<DossierWindowApi | null>(null)

export function useDossierWindow(): DossierWindowApi | null {
  return useContext(DossierWindowContext)
}
