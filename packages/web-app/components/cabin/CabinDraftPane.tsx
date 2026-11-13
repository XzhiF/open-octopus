'use client'

// 桌面内联新建工作舱（原型 index.html pendingCabin hero）：
// 左栏保持原样，对话区换成这张表单；创建/attach + init 后直接在本壳打开舱，
// 不跳 /cabin/new。表单本体与深链页面共用 CabinNewForm。

import { Container } from 'lucide-react'
import { CabinNewForm } from './CabinNewForm'

export interface CabinDraftPaneProps {
  onCreated: (cabinId: string) => void
  onCancel: () => void
}

export function CabinDraftPane({ onCreated, onCancel }: CabinDraftPaneProps) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto bg-pop-bg px-4 py-10"
      data-testid="cabin-draft-pane"
    >
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border-[1.5px] border-pop-bd bg-pop-paper text-pop-yellow">
            <Container className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-black text-pop-ink">描述要长期开发的工作舱</h1>
            <p className="text-[12px] text-pop-dim">一个目录 = 一个舱 · 创建后 agent 在对话里继续初始化</p>
          </div>
        </div>

        <CabinNewForm
          onCreated={onCreated}
          onCancel={onCancel}
          cancelLabel="返回对话"
        />
      </div>
    </div>
  )
}
