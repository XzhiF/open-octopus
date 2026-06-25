import { Bell } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface NotificationBadgeProps {
  count: number
  onClick?: () => void
}

export function NotificationBadge({ count, onClick }: NotificationBadgeProps) {
  if (count <= 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="relative p-1.5 rounded-md hover:bg-accent transition-colors"
          aria-label={`${count} 条未送达通知`}
        >
          <Bell className="h-4 w-4 text-agent-warn" />
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-agent-error text-[10px] font-medium text-agent-error-foreground">
            {count > 9 ? '9+' : count}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{count} 条未送达通知</TooltipContent>
    </Tooltip>
  )
}
