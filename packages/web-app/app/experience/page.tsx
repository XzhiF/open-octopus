'use client'

import { Suspense } from 'react'
import { KnowledgeTab } from '@/components/agent/knowledge/KnowledgeTab'

export default function ExperiencePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center flex-1 min-h-0">Loading...</div>}>
      <div className="relative flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-hidden">
          <KnowledgeTab />
        </div>
      </div>
    </Suspense>
  )
}
