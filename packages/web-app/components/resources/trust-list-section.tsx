"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { TrustSourceRow } from "@/components/resources/trust-source-row"
import { EmptyState } from "@/components/resources/empty-state"
import { Plus, Shield, ShieldOff } from "lucide-react"
import type { TrustEntry, BlockedEntry } from "@/lib/types"

interface TrustListSectionProps {
  trusted: TrustEntry[]
  blocked: BlockedEntry[]
  onAddTrust: () => void
  onAddBlock: () => void
  onRemoveTrust: (protocol: string, location: string) => void
  onRemoveBlock: (protocol: string, location: string) => void
}

export function TrustListSection({
  trusted,
  blocked,
  onAddTrust,
  onAddBlock,
  onRemoveTrust,
  onRemoveBlock,
}: TrustListSectionProps) {
  return (
    <div className="space-y-8">
      {/* Trusted sources */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="size-4 text-resource-trusted" />
            信任来源 ({trusted.length})
          </CardTitle>
          <Button variant="outline" size="sm" onClick={onAddTrust} className="gap-1.5">
            <Plus className="size-3.5" />
            添加
          </Button>
        </CardHeader>
        <CardContent className="space-y-0 divide-y">
          {trusted.length === 0 ? (
            <div className="py-8">
              <EmptyState
                icon={Shield}
                title="暂无信任来源"
                description="添加信任来源后，从该来源安装资源时将跳过信任确认"
              />
            </div>
          ) : (
            trusted.map(entry => (
              <TrustSourceRow
                key={`${entry.protocol}:${entry.location}`}
                entry={entry}
                variant="trusted"
                onRemove={() => onRemoveTrust(entry.protocol, entry.location)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Blocked sources */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldOff className="size-4 text-resource-blocked" />
            阻止来源 ({blocked.length})
          </CardTitle>
          <Button variant="outline" size="sm" onClick={onAddBlock} className="gap-1.5">
            <Plus className="size-3.5" />
            添加
          </Button>
        </CardHeader>
        <CardContent className="space-y-0 divide-y">
          {blocked.length === 0 ? (
            <div className="py-8">
              <EmptyState
                icon={ShieldOff}
                title="暂无阻止来源"
                description="阻止的来源即使使用 --trust 也不允许注册或安装"
              />
            </div>
          ) : (
            blocked.map(entry => (
              <TrustSourceRow
                key={`${entry.protocol}:${entry.location}`}
                entry={entry}
                variant="blocked"
                onRemove={() => onRemoveBlock(entry.protocol, entry.location)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
