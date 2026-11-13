'use client'

// /cabin/new 深链兜底页：桌面内联新建（CabinDraftPane）是主入口；
// 直接访问 /cabin/new 时仍渲染这份页面，表单与内联 hero 共用 CabinNewForm。
// 创建成功 → /cabin/:id（兄弟壳深链）；取消 → 桌面。

import { Container } from 'lucide-react'
import { useRouter } from '@/lib/app-navigation'
import { CabinNewForm } from './CabinNewForm'

export function CabinNewHero() {
  const router = useRouter()

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-pop-bg px-4 py-10" data-testid="cabin-new-hero">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border-[1.5px] border-pop-bd bg-pop-paper text-pop-yellow">
            <Container className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-black text-pop-ink">新建作战舱</h1>
            <p className="text-[12px] text-pop-dim">绑定一个目录 · 长期存活的开发座舱 · 一切由主对话驱动</p>
          </div>
        </div>

        <CabinNewForm
          onCreated={(cabinId) => router.push(`/cabin/${cabinId}`)}
          onCancel={() => router.push('/')}
        />
      </div>
    </div>
  )
}
