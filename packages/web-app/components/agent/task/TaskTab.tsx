'use client'

import { useState } from 'react'
import { ClipboardList, Play, Clock, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentTasks } from '@/hooks/useAgentTasks'
import { ActiveTaskList } from './ActiveTaskList'
import { ScheduledJobList } from './ScheduledJobList'
import { ReportList } from './ReportList'
import { AgentEmptyState } from '../shared/AgentEmptyState'

const SUB_VIEWS = [
  { id: 'active', label: '进行中', icon: Play },
  { id: 'scheduled', label: '定时任务', icon: Clock },
  { id: 'reports', label: '报告', icon: FileText },
] as const

export function TaskTab() {
  const [activeView, setActiveView] = useState<string>('active')
  const { activeTasks, scheduledJobs, reports, loading, error, cancelTask } = useAgentTasks()

  const hasData = activeTasks.length > 0 || scheduledJobs.length > 0 || reports.length > 0

  if (!loading && !hasData) {
    return (
      <AgentEmptyState
        icon={ClipboardList}
        title="暂无任务"
        description="通过对话下达任务后，工作流执行进度和定时任务将在这里展示。"
      />
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        {SUB_VIEWS.map((view) => {
          const Icon = view.icon
          const count = view.id === 'active' ? activeTasks.length :
                       view.id === 'scheduled' ? scheduledJobs.length :
                       reports.length
          return (
            <button
              key={view.id}
              onClick={() => setActiveView(view.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                activeView === view.id
                  ? 'bg-agent-primary-light text-agent-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {view.label}
              {count > 0 && (
                <span className="text-xs bg-muted rounded-full px-1.5 py-0.5">{count}</span>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeView === 'active' && (
          <ActiveTaskList tasks={activeTasks} loading={loading} onCancel={cancelTask} />
        )}
        {activeView === 'scheduled' && (
          <ScheduledJobList jobs={scheduledJobs} loading={loading} />
        )}
        {activeView === 'reports' && (
          <ReportList reports={reports} loading={loading} />
        )}
      </div>
    </div>
  )
}
