"use client"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { RefreshCw, CheckCircle2, AlertTriangle, Loader2, Wrench } from "lucide-react"
import { syncResources, type DriftItem } from "@/lib/resource/api"

export function DriftList() {
  const [state, setState] = useState<"idle" | "checking" | "clean" | "has-drifts" | "fixing" | "fixed">("idle")
  const [drifts, setDrifts] = useState<DriftItem[]>([])
  const [fixingItems, setFixingItems] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const handleCheck = useCallback(async () => {
    setState("checking")
    setError(null)
    try {
      const res = await syncResources(false)
      setDrifts(res.data.drifts)
      setState(res.data.totalDrifts === 0 ? "clean" : "has-drifts")
    } catch (e) {
      setError(e instanceof Error ? e.message : "检测失败")
      setState("idle")
    }
  }, [])

  const handleFixAll = useCallback(async () => {
    setState("fixing")
    try {
      const res = await syncResources(true)
      setDrifts(res.data.drifts)
      setState("fixed")
    } catch (e) {
      setError(e instanceof Error ? e.message : "修复失败")
      setState("has-drifts")
    }
  }, [])

  const handleFixOne = useCallback(async (resource: string) => {
    setFixingItems((prev) => new Set(prev).add(resource))
    try {
      const res = await syncResources(true, [resource])
      setDrifts((prev) =>
        prev.map((d) =>
          d.resource === resource ? { ...d, fixed: res.data.drifts[0]?.fixed ?? true } : d
        )
      )
    } catch {
      // Keep item unfixed on error
    } finally {
      setFixingItems((prev) => {
        const next = new Set(prev)
        next.delete(resource)
        return next
      })
    }
  }, [])

  const issueLabel: Record<string, string> = {
    MISSING: "文件缺失",
    MODIFIED: "内容被修改",
    EXTRA: "多余文件",
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base">漂移检测</CardTitle>
        <Button variant="outline" size="sm" onClick={handleCheck} disabled={state === "checking"}>
          {state === "checking" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          检测
        </Button>
      </CardHeader>
      <CardContent>
        {state === "idle" && (
          <p className="text-sm text-muted-foreground">点击「检测」扫描资源漂移</p>
        )}

        {state === "checking" && (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">扫描中...</span>
          </div>
        )}

        {state === "clean" && (
          <Alert className="border-green-500/50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription>所有资源一致，无漂移</AlertDescription>
          </Alert>
        )}

        {(state === "has-drifts" || state === "fixing") && (
          <div className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                发现 {drifts.length} 项漂移
              </span>
              <Button
                size="sm"
                onClick={handleFixAll}
                disabled={state === "fixing"}
              >
                {state === "fixing" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                全部修复
              </Button>
            </div>
            <ul className="space-y-2">
              {drifts.map((d) => (
                <li
                  key={d.resource}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={d.issue === "MISSING" ? "destructive" : "outline"} className="text-xs">
                      {issueLabel[d.issue] ?? d.issue}
                    </Badge>
                    <span className="text-sm font-medium">{d.resource}</span>
                    <span className="text-xs text-muted-foreground">{d.type}</span>
                  </div>
                  <div>
                    {d.fixed ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleFixOne(d.resource)}
                        disabled={fixingItems.has(d.resource)}
                      >
                        {fixingItems.has(d.resource) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "修复"
                        )}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state === "fixed" && (
          <Alert className="border-green-500/50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription>
              漂移修复完成，{drifts.filter((d) => d.fixed).length}/{drifts.length} 项已修复
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
