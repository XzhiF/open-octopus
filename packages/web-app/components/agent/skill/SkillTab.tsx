'use client'

import { useState } from 'react'
import { Zap, History, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentSkills } from '@/hooks/useAgentSkills'
import { SkillDetailView } from './SkillDetailView'
import { ChangelogTimeline } from './ChangelogTimeline'
import { ExperienceList } from './ExperienceList'

const SUB_VIEWS = [
  { id: 'skills', label: 'SKILL 列表', icon: Zap },
  { id: 'changelog', label: '进化日志', icon: History },
  { id: 'experiences', label: '经验库', icon: BookOpen },
] as const

export function SkillTab() {
  const [activeView, setActiveView] = useState('skills')
  const { skills, changelog, experiences, loading, error, fetchExperiences, rollback, refetch } = useAgentSkills()

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        {SUB_VIEWS.map((view) => {
          const Icon = view.icon
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
      <div className="flex-1 overflow-hidden">
        {activeView === 'skills' && (
          <SkillDetailView
            skills={skills}
            loading={loading}
            onRefresh={refetch}
          />
        )}
        {activeView === 'changelog' && (
          <div className="h-full overflow-auto">
            <ChangelogTimeline entries={changelog} loading={loading} onRollback={rollback} />
          </div>
        )}
        {activeView === 'experiences' && (
          <div className="h-full overflow-auto">
            <ExperienceList experiences={experiences} loading={loading} onSearch={(q) => fetchExperiences({ q })} />
          </div>
        )}
      </div>
    </div>
  )
}
