'use client'

import { Suspense } from 'react'
import { KnowledgeTab } from '@/components/agent/knowledge/KnowledgeTab'

export default function ExperiencePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-3.5rem)]">Loading...</div>}>
      <div className="relative flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="flex-1 overflow-hidden">
          <KnowledgeTab />
        </div>
      </div>
    </Suspense>
  )
}
