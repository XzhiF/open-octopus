'use client'

// 本舱变更窗的挂载层（v22 十三轮）：右栏「变更」/ ⌥G 打开。
// 做成独立挂载而不是塞进 CockpitFace —— 详情面没选中时也要能开（同目录窗）。

import { setChangesOpen, useChangesOpen } from './changes-store'
import { CockpitChangesWindow } from './CockpitChangesWindow'

export function CockpitCabinChanges({ cabinId }: { cabinId: string }) {
  const open = useChangesOpen()
  if (!open) return null
  return (
    <CockpitChangesWindow
      key={cabinId}
      cabinId={cabinId}
      onClose={() => setChangesOpen(false)}
    />
  )
}
