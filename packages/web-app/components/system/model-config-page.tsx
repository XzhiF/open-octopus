"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { toast } from "sonner"
import { Save, TestTube2, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { WorkflowYamlEditor } from "@/components/workspace/workflow-yaml-editor"
import {
  fetchModelConfig,
  saveModelConfig,
  testProvider,
  testAllProviders,
  type ValidationError,
  type ConnectivityResult,
} from "@/lib/model-config-api"

interface ProviderEntry {
  name: string
  kind: "builtin" | "custom"
}

function parseProviders(content: string): ProviderEntry[] {
  try {
    // ponytail: regex-based extraction avoids pulling js-yaml into the client bundle
    const providers: ProviderEntry[] = []

    // Match top-level "providers:" block keys
    const providersMatch = content.match(/^providers:\s*\n((?:[ \t]+\S.*\n?)*)/m)
    if (providersMatch) {
      const block = providersMatch[1]
      const keys = block.matchAll(/^[ \t]+(\w[\w-]*):\s*$/gm)
      for (const m of keys) {
        providers.push({ name: m[1], kind: "builtin" })
      }
    }

    // Match "custom_providers:" block keys
    const customMatch = content.match(/^custom_providers:\s*\n((?:[ \t]+\S.*\n?)*)/m)
    if (customMatch) {
      const block = customMatch[1]
      const keys = block.matchAll(/^[ \t]+(\w[\w-]*):\s*$/gm)
      for (const m of keys) {
        providers.push({ name: m[1], kind: "custom" })
      }
    }

    return providers
  } catch {
    return []
  }
}

export function ModelConfigPage() {
  const [content, setContent] = useState("")
  const [savedContent, setSavedContent] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<ValidationError[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Map<string, ConnectivityResult>>(new Map())
  const [testingProvider, setTestingProvider] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)

  const contentRef = useRef(content)
  contentRef.current = content

  // Load initial config
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await fetchModelConfig()
        if (!cancelled) {
          setContent(data.content)
          setSavedContent(data.content)
          setLoading(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const isDirty = content !== savedContent

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setErrors([])
    try {
      await saveModelConfig(contentRef.current)
      setSavedContent(contentRef.current)
      toast.success("模型配置已保存，立即生效")
    } catch (err: unknown) {
      const e = err as Error & { details?: ValidationError[] }
      if (e.details && Array.isArray(e.details)) {
        setErrors(e.details)
        toast.error(`校验失败：${e.details.length} 个错误`)
      } else {
        toast.error(e.message || "保存失败")
      }
    } finally {
      setSaving(false)
    }
  }, [saving])

  const handleTestProvider = useCallback(async (name: string) => {
    setTestingProvider(name)
    try {
      const result = await testProvider(name)
      setTestResults(prev => new Map(prev).set(name, result))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestResults(prev => new Map(prev).set(name, {
        provider: name, success: false, error: msg,
      }))
    } finally {
      setTestingProvider(null)
    }
  }, [])

  const handleTestAll = useCallback(async () => {
    setTestingAll(true)
    try {
      const { results } = await testAllProviders()
      const map = new Map<string, ConnectivityResult>()
      for (const r of results) map.set(r.provider, r)
      setTestResults(map)
      const failed = results.filter(r => !r.success).length
      if (failed === 0) {
        toast.success(`全部 ${results.length} 个 provider 连通`)
      } else {
        toast.error(`${failed}/${results.length} 个 provider 连接失败`)
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingAll(false)
    }
  }, [])

  const providers = parseProviders(content)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">加载失败</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{loadError}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <h2 className="text-lg font-semibold">模型配置</h2>
        <div className="flex-1" />
        {isDirty && (
          <span className="text-xs text-amber-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> 未保存
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleTestAll}
          disabled={testingAll || providers.length === 0}
        >
          {testingAll ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <TestTube2 className="h-4 w-4 mr-1" />
          )}
          全部测试
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1" />
          )}
          保存
        </Button>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <WorkflowYamlEditor
          value={content}
          onChange={setContent}
          onSave={handleSave}
        />
      </div>

      {/* Validation errors */}
      {errors.length > 0 && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 max-h-48 overflow-auto">
          <h3 className="text-sm font-medium text-destructive mb-2 flex items-center gap-1">
            <XCircle className="h-4 w-4" /> 校验错误
          </h3>
          <ul className="space-y-1">
            {errors.map((err, i) => (
              <li key={i} className="text-xs text-destructive/90 font-mono">
                {err.path ? <span className="text-destructive font-semibold">{err.path}</span> : null}
                {err.path ? ": " : ""}{err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Provider test results */}
      {providers.length > 0 && (
        <div className="border-t border-border px-4 py-3 max-h-64 overflow-auto">
          <h3 className="text-sm font-medium mb-2">Providers</h3>
          <div className="space-y-1">
            {providers.map((p) => {
              const result = testResults.get(p.name)
              const isTesting = testingProvider === p.name
              return (
                <div
                  key={`${p.kind}-${p.name}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">
                    {p.kind === "custom" ? "custom" : "builtin"}
                  </span>
                  <span className="font-medium">{p.name}</span>
                  {isTesting ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  ) : result ? (
                    result.success ? (
                      <span className="flex items-center gap-1 text-green-600 text-xs">
                        <CheckCircle2 className="h-3 w-3" />
                        {result.latency}ms
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-destructive text-xs" title={result.error}>
                        <XCircle className="h-3 w-3" />
                        {result.error?.slice(0, 60) ?? "失败"}
                      </span>
                    )
                  ) : null}
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleTestProvider(p.name)}
                    disabled={isTesting}
                  >
                    测试
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
