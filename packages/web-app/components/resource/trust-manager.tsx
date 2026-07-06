"use client"

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Shield, ShieldOff, Plus, RefreshCw } from "lucide-react"
import { useResourceOrg } from "./resource-context"

interface TrustEntry {
  source: string
  trustedAt: string
  type: "trust" | "block"
  reason?: string
}

// Placeholder — server API not yet implemented
const MOCK_TRUST_STORE: TrustEntry[] = [
  { source: "builtin:*", trustedAt: "2026-01-01T00:00:00Z", type: "trust" },
]

export function TrustManager() {
  const org = useResourceOrg()
  const [entries, setEntries] = useState<TrustEntry[]>(MOCK_TRUST_STORE)
  const [loading, setLoading] = useState(false)

  const trustEntries = entries.filter((e) => e.type === "trust")
  const blockEntries = entries.filter((e) => e.type === "block")

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setLoading(true)} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
        <Button variant="outline" size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          添加信任来源
        </Button>
        <Button variant="outline" size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          添加阻止来源
        </Button>
      </div>

      {/* Trusted sources */}
      <div className="mb-6">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4 text-green-600" />
          信任来源
        </h3>
        {trustEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无信任来源</p>
        ) : (
          <div className="space-y-2">
            {trustEntries.map((entry) => (
              <Card key={entry.source} className="flex items-center justify-between p-3">
                <span className="font-mono text-sm">{entry.source}</span>
                <span className="text-xs text-muted-foreground">
                  信任于 {new Date(entry.trustedAt).toLocaleDateString("zh-CN")}
                </span>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Blocked sources */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldOff className="h-4 w-4 text-red-600" />
          阻止来源
        </h3>
        {blockEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无阻止来源</p>
        ) : (
          <div className="space-y-2">
            {blockEntries.map((entry) => (
              <Card key={entry.source} className="p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm">{entry.source}</span>
                  <span className="text-xs text-muted-foreground">
                    阻止于 {new Date(entry.trustedAt).toLocaleDateString("zh-CN")}
                  </span>
                </div>
                {entry.reason && (
                  <p className="mt-1 text-xs text-muted-foreground">原因: {entry.reason}</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
