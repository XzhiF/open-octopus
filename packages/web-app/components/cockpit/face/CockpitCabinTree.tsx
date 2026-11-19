'use client'

// 本舱目录窗的挂载层（v22 九轮）：右栏「目录」/ ⌥F 打开。
// 做成独立挂载而不是塞进 CockpitFace —— 详情面没选中时 CockpitFace 会整块不渲染，
// 本舱目录却要随时能看。窗口本体复用 CockpitTreeWindow 的 scope.mode = 'cabin'。

import { useMemo } from 'react'
import { setCabinTreeOpen, useCabinTreeOpen } from './cabin-tree-store'
import { CockpitTreeWindow } from './CockpitTreeWindow'
import type { CockpitTreeScope } from './tree-window'

export function CockpitCabinTree({ cabinId }: { cabinId: string }) {
  const open = useCabinTreeOpen()
  const scope = useMemo<CockpitTreeScope>(
    () => ({ cabinId, projects: [], active: '', mode: 'cabin' }),
    [cabinId],
  )
  if (!open) return null
  return (
    <CockpitTreeWindow
      key={cabinId}
      scope={scope}
      onClose={() => setCabinTreeOpen(false)}
    />
  )
}
