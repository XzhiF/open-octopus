"use client"

import { cn } from "@/lib/utils"
import type { ExpertStatus } from "@/lib/swarm-types"
import { StatusDot } from "./status-dot"

export interface ExpertAvatarProps {
  role: string
  size?: "xs" | "sm" | "md"
  status?: ExpertStatus
}

const AVATAR_COLORS = [
  "#d97757", "#7fa3a8", "#8ba88e", "#c9a35c", "#43596b",
  "#b4534a", "#6e6862", "#d97757", "#8ba88e", "#7fa3a8",
]

function hashRole(role: string): number {
  let sum = 0
  for (let i = 0; i < role.length; i++) {
    sum += role.charCodeAt(i)
  }
  return sum % 10
}

function getAbbreviation(role: string): string {
  const cleaned = role.replace(/[-_]/g, " ").trim()
  const words = cleaned.split(/\s+/)
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  return role.slice(0, 2).toUpperCase()
}

const sizeMap = {
  xs: "h-6 w-6 text-[9px]",
  sm: "h-8 w-8 text-[10px]",
  md: "h-10 w-10 text-xs",
}

export function ExpertAvatar({ role, size = "md", status }: ExpertAvatarProps) {
  const colorIndex = hashRole(role)
  const bgColor = AVATAR_COLORS[colorIndex]
  const abbreviation = getAbbreviation(role)

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={cn(
          "inline-flex items-center justify-center rounded-full font-semibold text-pop-bg",
          sizeMap[size],
        )}
        style={{ backgroundColor: bgColor }}
        title={role}
      >
        {abbreviation}
      </div>
      {status && (
        <div className={cn(
          "absolute -bottom-0.5 -right-0.5",
          size === "xs" && "-bottom-0.5 -right-0.5",
        )}>
          <StatusDot status={status} pulse={status === "running"} size="sm" />
        </div>
      )}
    </div>
  )
}
