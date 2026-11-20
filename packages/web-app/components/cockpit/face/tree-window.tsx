'use client'

// 目录树窗口的作用域 / 开关（v21 六轮）：
// 「项目」页签点一行 → 在本作战 dossier（z 201）之上再弹一个窗口（z 202），
// 只看**本作战自己的项目** —— 任务 = task.project_ids，会话 = project_keys；
// 不列全舱舱籍。契约与原型 renderTwin 同口径。
//
// 作用域在这里只放「项目锚点」；舱籍条目（分支 / 绝对路径 / repo 名）由窗口
// 自己从 useCabinProjects 读，树与文件走 /repos/:name/tree|file（ff-only 只读）。

import { createContext, useContext } from 'react'

export interface CockpitTreeScope {
  cabinId: string
  /** 本作战的项目锚点（key 或名字）。 */
  projects: readonly string[]
  /** 打开时的项目锚点。 */
  active: string
  /** 'cabin' = 本舱 cwd 只读树（右栏「目录」）；缺省 = 作业的项目 worktree。 */
  mode?: 'cabin'
}

export interface CockpitTreeApi {
  open(scope: CockpitTreeScope): void
}

export const CockpitTreeContext = createContext<CockpitTreeApi | null>(null)

export function useCockpitTree(): CockpitTreeApi | null {
  return useContext(CockpitTreeContext)
}
