'use client'

// /cabin/new 深链兜底：v4 起新建只有一个地方 —— 桌面壳里的「一行草稿 + 右页大输入框」。
// 直接访问这条路径时，把草稿打开并切回桌面，不再维护第二套表单
// （plan §10 P4：退役 CabinNewForm / CabinDraftPane）。

import { useEffect } from 'react'
import { Container } from 'lucide-react'
import { useRouter } from '@/lib/app-navigation'
import { useCabinMode } from './cabin-mode'

export function CabinNewHero() {
  const router = useRouter()
  const { startDraft } = useCabinMode()

  useEffect(() => {
    startDraft()
    router.push('/')
  }, [startDraft, router])

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center gap-3 bg-pop-bg px-4 py-10 text-pop-dim"
      data-testid="cabin-new-redirect"
    >
      <span className="grid size-10 place-items-center rounded-xl border-[1.5px] border-pop-bd bg-pop-paper text-pop-yellow">
        <Container className="size-5" />
      </span>
      <div>
        <div className="text-[13px] font-bold text-pop-ink">正在打开新建作战舱…</div>
        <div className="text-[11.5px] text-pop-dim">说说它要做什么 —— 名字由汐音来取。</div>
      </div>
    </div>
  )
}