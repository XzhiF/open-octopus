"use client"

import { useOrgs, type OrgOption } from "@/hooks/useOrgs"
import { Loader2 } from "lucide-react"

interface OrgSelectorProps {
  value: string
  onChange: (org: string) => void
}

export function OrgSelector({ value, onChange }: OrgSelectorProps) {
  const { orgs, loading, error } = useOrgs()

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-sm text-destructive">{error}</div>
    )
  }

  if (orgs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">暂无组织</div>
    )
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 px-2 text-sm rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {orgs.map((org: OrgOption) => (
        <option key={org.name} value={org.name}>
          {org.name}
        </option>
      ))}
    </select>
  )
}
