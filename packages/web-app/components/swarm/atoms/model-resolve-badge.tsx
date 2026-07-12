"use client"

import { resolveMoaModel, type MoaModelResolution } from "@/lib/moa-model-resolver"
import type { ModelAliasConfig } from "@octopus/shared"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react"

export interface ModelResolveBadgeProps {
  modelId: string
  providerType: string
  tierMap: Record<string, Record<string, string>>
}

export function ModelResolveBadge({ modelId, providerType, tierMap }: ModelResolveBadgeProps) {
  if (!modelId) return null

  // ponytail: construct minimal ModelAliasConfig from providers map
  const config: ModelAliasConfig = { default: "pro", providers: tierMap, custom_providers: {} }
  const resolution = resolveMoaModel(modelId, providerType, config)

  const isExact = !resolution.degraded && resolution.resolved === modelId

  if (isExact) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[10px] px-1.5 py-0 bg-moa-resolve-exact/10 text-moa-resolve-exact border-moa-resolve-exact/40"
        role="status"
        aria-label={`模型解析: 精确匹配 ${resolution.resolved}`}
      >
        <CheckCircle className="h-2.5 w-2.5" />
        {resolution.resolved}
      </Badge>
    )
  }

  if (resolution.degraded) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 text-[10px] px-1.5 py-0 bg-moa-resolve-degraded-light text-moa-resolve-degraded border-moa-resolve-degraded/40 cursor-default"
            role="status"
            aria-live="polite"
            aria-label={`模型解析: 降级匹配 ${resolution.resolved}`}
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {resolution.resolved} (降级)
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <p className="text-xs font-medium mb-1">降级链</p>
          <p className="text-xs text-muted-foreground">
            {resolution.chain.join(" → ")}
          </p>
        </TooltipContent>
      </Tooltip>
    )
  }

  // Cannot resolve
  return (
    <Badge
      variant="outline"
      className="gap-1 text-[10px] px-1.5 py-0 bg-moa-resolve-error-light text-moa-resolve-error border-moa-resolve-error/40"
      role="status"
      aria-live="polite"
      aria-label="模型解析: 无法解析"
    >
      <XCircle className="h-2.5 w-2.5" />
      无法解析
    </Badge>
  )
}
