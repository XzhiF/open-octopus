import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface AgentEmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}

export function AgentEmptyState({ icon: Icon, title, description, actionLabel, onAction }: AgentEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center" role="status" aria-live="polite">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-agent-primary-light mb-4">
        <Icon className="h-8 w-8 text-agent-primary" />
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-6">{description}</p>
      {actionLabel && onAction && (
        <Button onClick={onAction} className="bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground">
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
