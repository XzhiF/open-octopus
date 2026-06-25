'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface AgentChatBoundaryProps {
  context: 'agent' | 'workspace'
}

export function AgentChatBoundary({ context }: AgentChatBoundaryProps) {
  const [collapsed, setCollapsed] = useState(true)

  return (
    <div className={cn(
      'mx-4 mt-3 rounded-lg border text-sm',
      context === 'agent'
        ? 'border-agent-primary/20 bg-agent-primary/5'
        : 'border-agent-info/20 bg-agent-info/5',
    )}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <Info className="h-4 w-4 shrink-0 text-agent-primary" />
        <span className="font-medium flex-1">
          {context === 'agent' ? 'Agent 全局编排模式' : '工作空间内开发模式'}
        </span>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 text-muted-foreground space-y-2">
          <p>
            {context === 'agent' ? (
              <>
                Agent 作为<strong>全局编排器</strong>，负责任务分解、工作流调度和分身管理。
                它会智能匹配已有工作流链，或在无匹配时动态生成新工作流。
                适合<strong>全局编排</strong>和跨项目协调。
              </>
            ) : (
              <>
                工作空间内开发专注于<strong>工作空间内开发</strong>，直接操作项目代码。
                Agent 会在绑定的 workspace 范围内执行编码、测试和提交操作。
              </>
            )}
          </p>
          <p className="text-xs">
            {context === 'agent'
              ? '提示：复杂开发任务会自动委派给分身处理，主 Agent 负责全局协调。'
              : '提示：所有操作限定在当前工作空间范围内，不会影响其他项目。'}
          </p>
        </div>
      )}
    </div>
  )
}
