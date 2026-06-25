"use client"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { HelpCircle } from "lucide-react"

interface CronInputProps {
  value: string
  onChange: (value: string) => void
  error?: string
  disabled?: boolean
}

const CRON_HELP = [
  "┌─── 分钟 (0-59)",
  "│ ┌─── 小时 (0-23)",
  "│ │ ┌─── 日 (1-31)",
  "│ │ │ ┌─── 月 (1-12)",
  "│ │ │ │ ┌─── 星期 (0-7)",
  "│ │ │ │ │",
  "* * * * *",
].join("\n")

export function CronInput({ value, onChange, error, disabled }: CronInputProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 9 * * 1-5"
          disabled={disabled}
          className={cn(
            "font-mono text-sm",
            error && "border-destructive focus-visible:ring-destructive/20"
          )}
          aria-invalid={!!error}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-muted-foreground">
              <HelpCircle className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            <pre className="whitespace-pre font-mono text-xs leading-relaxed">
              {CRON_HELP}
            </pre>
          </TooltipContent>
        </Tooltip>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
