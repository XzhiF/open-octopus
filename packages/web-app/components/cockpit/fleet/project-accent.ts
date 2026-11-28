// v22（2026-11-27 用户）：编队独立 chat 窗要和主通讯台「长得一样、颜色不一样」—
// 项目四色收敛到这一处，编队行 / 独立窗 / WINDOWS chip 共用同一个锚点算法。
//
// 旧色板（天蓝 / 紫 / 琥珀 / 绿）里的 #8B7CF6 与主通讯台同色系，开两扇窗就分不清
// 哪扇是主台；新四色拉开色相、并避开主台的薄荷青（#2EE6D6）。

import type { CockpitRow } from './fleet-model'
import { rowProjectKeys } from '../projects/project-model'

/** 原型 cockpit-v22 · PROJECTS：ledger / gateway / risk / edge。 */
export const PROJECT_ACCENTS = ['#4D8DFF', '#D45BFF', '#FF9E2C', '#8FE24B'] as const

/** 主通讯台身份色（与 --ck12-teal 同值）：窗的缺省回退，不做第五种项目色。 */
export const MAIN_ACCENT = '#2EE6D6'

export function accentOfAnchor(anchor: string): string {
  let hash = 0
  for (let i = 0; i < anchor.length; i += 1) hash = (hash * 31 + anchor.charCodeAt(i)) | 0
  return PROJECT_ACCENTS[Math.abs(hash) % PROJECT_ACCENTS.length]
}

/** 编队行锚点：有项目 key 用第一个项目，没有就退回行 key（不猜）。 */
export function accentOfRow(row: CockpitRow): string {
  const anchor = row.kind === 'job' ? rowProjectKeys(row)[0] ?? row.key : row.key
  return accentOfAnchor(anchor)
}
