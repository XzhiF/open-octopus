"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Trash2 } from "lucide-react"
import type { TrustEntry, BlockedEntry } from "@/lib/types"

interface TrustSourceRowProps {
  entry: TrustEntry | BlockedEntry
  variant: "trusted" | "blocked"
  onRemove?: () => void
  removable?: boolean
}

export function TrustSourceRow({ entry, variant, onRemove, removable = true }: TrustSourceRowProps) {
  const ref = `${entry.protocol}:${entry.location}`
  const isBlocked = variant === "blocked"
  const blockedEntry = isBlocked ? entry as BlockedEntry : null
  const trustedEntry = !isBlocked ? entry as TrustEntry : null
  const isBuiltin = entry.protocol === "builtin"

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 py-3 px-1">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className={cn(
            "text-sm font-mono truncate",
            isBlocked && "text-destructive"
          )}>
            {ref}
          </code>
          {isBuiltin && (
            <Badge variant="secondary" aria-label="内置来源，始终信任">始终信任</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {blockedEntry?.reason && <span>原因: {blockedEntry.reason} · </span>}
          {trustedEntry && <span>信任于 {new Date(trustedEntry.trusted_at).toLocaleDateString("zh-CN")}</span>}
          {blockedEntry && !blockedEntry.reason && <span>阻止于 {new Date(blockedEntry.blocked_at).toLocaleDateString("zh-CN")}</span>}
        </div>
      </div>

      {removable && !isBuiltin && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "gap-1.5 shrink-0",
            isBlocked ? "text-muted-foreground" : "text-destructive hover:text-destructive"
          )}
          onClick={onRemove}
          aria-label={`移除${isBlocked ? "阻止" : "信任"}来源 ${ref}`}
        >
          <Trash2 className="size-3.5" />
          移除
        </Button>
      )}
    </div>
  )
}
