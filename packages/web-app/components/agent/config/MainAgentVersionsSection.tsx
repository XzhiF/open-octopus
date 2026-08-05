'use client'

import { useState } from 'react'
import { History, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfigSection } from './ConfigSection'
import { CloneVersionsTab } from '../clone/CloneVersionsTab'

export function MainAgentVersionsSection() {
  const [expanded, setExpanded] = useState(false)

  return (
    <ConfigSection
      title="Main Agent 版本管理"
      description="发布和管理 Main Agent 的配置快照（persona + config + skills）。"
    >
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <History className="h-4 w-4" />
        {expanded ? '收起版本管理' : '展开版本管理'}
      </Button>

      {expanded && (
        <div className="border border-agent-divider rounded-md overflow-hidden" style={{ height: '400px' }}>
          <CloneVersionsTab agentName="__main__" />
        </div>
      )}
    </ConfigSection>
  )
}
