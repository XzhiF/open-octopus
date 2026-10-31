'use client'

import { lazy, Suspense } from 'react'
import { usePathname } from '@/lib/app-navigation'

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载视图…
    </div>
  )
}

const SystemLayout = lazy(() => import('@/app/system/layout'))

const PAGES = {
  models: lazy(() => import('@/app/system/models/page')),
  billing: lazy(() => import('@/app/system/billing/page')),
  repos: lazy(() => import('@/app/system/repos/page')),
  harness: lazy(() => import('@/app/system/harness/page')),
}

export function SystemView() {
  const pathname = usePathname()
  const section = pathname.split('/')[2] || 'models'
  const Page = PAGES[section as keyof typeof PAGES] ?? PAGES.models

  return (
    <Suspense fallback={<ViewLoading />}>
      <SystemLayout>
        <Suspense fallback={<ViewLoading />}>
          <Page />
        </Suspense>
      </SystemLayout>
    </Suspense>
  )
}
