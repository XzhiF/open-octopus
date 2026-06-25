'use client'

import { Bug, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface AgentTopBarProps {
  debugMode?: boolean
  safeMode?: boolean
  notificationCount?: number
}

export function AgentTopBar({ debugMode, safeMode, notificationCount }: AgentTopBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-b border-agent-divider bg-agent-surface-raised text-sm">
      {debugMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-agent-info border-agent-info/30 bg-agent-info-light">
              <Bug className="h-3 w-3" />
              调试模式
            </Badge>
          </TooltipTrigger>
          <TooltipContent>调试模式已开启，将记录详细的 Agent 决策日志</TooltipContent>
        </Tooltip>
      )}
      {safeMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-agent-error border-agent-error/30 bg-agent-error-light animate-pulse">
              <ShieldAlert className="h-3 w-3" />
              安全降级模式
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Agent 处于安全降级模式，写操作已被限制</TooltipContent>
        </Tooltip>
      )}
      <div className="flex-1" />
      {notificationCount && notificationCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-agent-warn border-agent-warn/30 bg-agent-warn-light cursor-pointer">
              {notificationCount} 条未送达通知
            </Badge>
          </TooltipTrigger>
          <TooltipContent>有通知未能送达，点击查看详情</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
