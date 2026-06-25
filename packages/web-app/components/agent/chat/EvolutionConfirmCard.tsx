'use client'

import { useState } from 'react'
import { Sparkles, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface EvolutionConfirmCardProps {
  eventId: string
  detail: string
  onConfirm: (decision: 'accept' | 'reject') => void
}

export function EvolutionConfirmCard({ detail, onConfirm }: EvolutionConfirmCardProps) {
  const [decided, setDecided] = useState<'accept' | 'reject' | null>(null)

  const handleDecision = (decision: 'accept' | 'reject') => {
    setDecided(decision)
    onConfirm(decision)
  }

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4',
        decided === 'accept' ? 'border-agent-success bg-agent-success-light' :
        decided === 'reject' ? 'border-muted bg-muted' :
        'border-agent-accent bg-agent-accent-light'
      )}
    >
      <div className="flex items-start gap-3">
        <Sparkles className="h-5 w-5 text-agent-accent shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-semibold text-sm">SKILL 进化确认</h4>
          <p className="text-sm text-muted-foreground mt-1">{detail}</p>
        </div>
      </div>

      {decided ? (
        <div className="mt-3 text-sm font-medium text-center">
          {decided === 'accept' ? '✅ 已采纳变更' : '❌ 已拒绝变更'}
        </div>
      ) : (
        <div className="flex gap-2 mt-3">
          <Button
            onClick={() => handleDecision('reject')}
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
          >
            <X className="h-4 w-4" />
            拒绝
          </Button>
          <Button
            onClick={() => handleDecision('accept')}
            size="sm"
            className="flex-1 gap-1.5 bg-agent-accent text-agent-primary-foreground hover:bg-agent-accent-hover"
          >
            <Check className="h-4 w-4" />
            采纳
          </Button>
        </div>
      )}
    </div>
  )
}
