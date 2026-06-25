import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ErrorStateProps {
  message: string
  onRetry?: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 px-4 text-center"
      )}
      role="alert"
    >
      <div className="text-scheduler-error mb-4">
        <AlertTriangle className="size-12" strokeWidth={1.5} />
      </div>
      <h3 className="text-lg font-semibold mb-1">加载失败</h3>
      <p className="text-muted-foreground text-sm max-w-sm mb-6">{message}</p>
      {onRetry && (
        <Button
          variant="outline"
          onClick={onRetry}
          aria-label="重试"
        >
          <RefreshCw className="size-4" />
          重试
        </Button>
      )}
    </div>
  )
}
