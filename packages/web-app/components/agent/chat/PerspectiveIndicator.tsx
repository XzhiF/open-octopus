'use client'

import { useState, useEffect } from 'react'
import { Users, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'

interface PerspectiveIndicatorProps {
  onSelectClone: (cloneName: string | null) => void
  activeClone: string | null
}

export function PerspectiveIndicator({ onSelectClone, activeClone }: PerspectiveIndicatorProps) {
  const [clones, setClones] = useState<Array<{ name: string; status: string }>>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    loadClones()
  }, [])

  const loadClones = async () => {
    try {
      const data = await api.listClones()
      const items = (data as { clones?: Array<{ name: string; status: string }> }).clones ?? []
      setClones(items)
    } catch {
      // Silent fallback — clones list unavailable
    }
  }

  const handleSelect = (name: string | null) => {
    onSelectClone(name)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
          activeClone
            ? 'bg-agent-accent/10 text-agent-accent border border-agent-accent/20'
            : 'bg-agent-surface-inset text-muted-foreground border border-agent-divider hover:bg-agent-surface-raised',
        )}
      >
        <Users className="h-3.5 w-3.5" />
        <span>视角：{activeClone ?? '主 Agent'}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 w-48 rounded-lg border border-agent-divider bg-agent-surface-raised shadow-lg overflow-hidden">
          <button
            onClick={() => handleSelect(null)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm hover:bg-agent-surface-inset transition-colors',
              !activeClone && 'bg-agent-primary/5 text-agent-primary font-medium',
            )}
          >
            主 Agent
          </button>
          {clones.map((clone) => (
            <button
              key={clone.name}
              onClick={() => handleSelect(clone.name)}
              className={cn(
                'w-full text-left px-3 py-2 text-sm hover:bg-agent-surface-inset transition-colors flex items-center justify-between',
                activeClone === clone.name && 'bg-agent-primary/5 text-agent-primary font-medium',
              )}
            >
              <span>{clone.name}</span>
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded',
                clone.status === 'running'
                  ? 'bg-agent-success/10 text-agent-success'
                  : 'bg-muted text-muted-foreground',
              )}>
                {clone.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
