'use client'

import dynamic from 'next/dynamic'

const ResourceLayout = dynamic(
  () => import('@/components/resource/resource-layout').then((m) => m.ResourceLayout),
  { ssr: false },
)
const ResourcesPage = dynamic(() => import('@/app/resources/page'), { ssr: false })

export function ResourcesView() {
  return (
    <ResourceLayout>
      <ResourcesPage />
    </ResourceLayout>
  )
}