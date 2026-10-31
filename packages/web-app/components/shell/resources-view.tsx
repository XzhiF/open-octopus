'use client'

import { lazy, Suspense } from 'react'

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载视图…
    </div>
  )
}

const ResourceLayout = lazy(() =>
  import('@/components/resource/resource-layout').then((m) => ({ default: m.ResourceLayout })),
)
const ResourcesPage = lazy(() => import('@/app/resources/page'))

export function ResourcesView() {
  return (
    <Suspense fallback={<ViewLoading />}>
      <ResourceLayout>
        <Suspense fallback={<ViewLoading />}>
          <ResourcesPage />
        </Suspense>
      </ResourceLayout>
    </Suspense>
  )
}
