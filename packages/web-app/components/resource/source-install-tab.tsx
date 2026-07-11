"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Package, FolderGit2, FolderOpen, RefreshCw, Loader2 } from "lucide-react"
import { listSources, installFromSource, installResource } from "@/lib/resource/api"
import { toast } from "sonner"

type SourceTab = "builtin" | "git" | "local"

function RefInstallForm({ placeholder, tabLabel }: { placeholder: string; tabLabel: string }) {
  const router = useRouter()
  const [ref, setRef] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleInstall = async () => {
    if (!ref.trim()) return
    setLoading(true)
    setError(null)
    try {
      await installResource(ref.trim())
      toast.success(`${tabLabel}资源 ${ref.trim()} 安装成功`)
      setRef("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-2">
        <Label htmlFor={`${tabLabel}-ref`}>来源引用</Label>
        <Input
          id={`${tabLabel}-ref`}
          placeholder={placeholder}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ref.trim()) handleInstall() }}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <Button onClick={handleInstall} disabled={loading || !ref.trim()}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        安装
      </Button>
    </Card>
  )
}

export function SourceInstallTab() {
  const [activeTab, setActiveTab] = useState<SourceTab>("git")
  const [sources, setSources] = useState<
    Array<{
      name: string
      url: string
      resourceCount: { skills: number; agents: number; workflows: number }
    }>
  >([])
  const [selectedSource, setSelectedSource] = useState("")
  const [group, setGroup] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ installed: number; skipped: number } | null>(null)

  const fetchSources = useCallback(async () => {
    try {
      const res = await listSources()
      setSources(res.sources)
    } catch {
      // ponytail: silent — empty list is acceptable fallback
    }
  }, [])

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const handleInstallAll = async () => {
    if (!selectedSource) return
    setLoading(true)
    setResult(null)
    try {
      const res = await installFromSource({
        sourceName: selectedSource,
        group: group || selectedSource,
        all: true,
      })
      setResult(res)
      toast.success(`从 ${selectedSource} 安装了 ${res.installed} 个资源`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "安装失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div aria-label="安装资源">
      <div className="mb-4 flex gap-1 border-b border-border">
        {(
          [
            { id: "builtin" as const, label: "内置", icon: Package },
            { id: "git" as const, label: "Git 源", icon: FolderGit2 },
            { id: "local" as const, label: "本地路径", icon: FolderOpen },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "git" && (
        <Card className="space-y-4 p-4">
          <div className="space-y-2">
            <Label>选择已添加的源</Label>
            <Select
              value={selectedSource}
              onValueChange={(v) => {
                setSelectedSource(v)
                setGroup(v)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择集合源..." />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name} ({s.resourceCount.agents}a {s.resourceCount.skills}s)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>组名</Label>
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="安装到哪个组目录"
            />
          </div>

          <Button onClick={handleInstallAll} disabled={!selectedSource || loading}>
            {loading && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
            全部安装
          </Button>

          {result && (
            <div className="text-sm">
              <Badge variant="outline" className="mr-2">
                ✓ {result.installed} installed
              </Badge>
              {result.skipped > 0 && (
                <Badge variant="secondary">{result.skipped} skipped</Badge>
              )}
            </div>
          )}
        </Card>
      )}

      {activeTab === "builtin" && (
        <RefInstallForm
          placeholder="builtin:brainstorming"
          tabLabel="内置"
        />
      )}

      {activeTab === "local" && (
        <RefInstallForm
          placeholder="local:/path/to/skill"
          tabLabel="本地"
        />
      )}
    </div>
  )
}
