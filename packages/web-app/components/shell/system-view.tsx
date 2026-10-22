'use client'

import dynamic from 'next/dynamic'
import { usePathname } from '@/lib/app-navigation'

const SystemLayout = dynamic(() => import('@/app/system/layout'), { ssr: false })

const PAGES = {
  models: dynamic(() => import('@/app/system/models/page'), { ssr: false }),
  billing: dynamic(() => import('@/app/system/billing/page'), { ssr: false }),
  repos: dynamic(() => import('@/app/system/repos/page'), { ssr: false }),
  harness: dynamic(() => import('@/app/system/harness/page'), { ssr: false }),
}

export function SystemView() {
  const pathname = usePathname()
  const section = pathname.split('/')[2] || 'models'
  const Page = PAGES[section as keyof typeof PAGES] ?? PAGES.models

  return (
    <SystemLayout>
      <Page />
    </SystemLayout>
  )
}