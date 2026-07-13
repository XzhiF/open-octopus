"use client"

import { useState, useEffect, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  ArrowLeft,
  Trash2,
  RefreshCw,
  BrainCircuit,
  Cog,
  Workflow,
  CheckCircle2,
  AlertTriangle,
  FileText,
  FileCode,
  File,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { uninstallResource, getResourceFiles } from "@/lib/resource/api"
import { toast } from "sonner"
import type { ResourceType } from "@/lib/resource/types"
import { UninstallConfirm } from "./UninstallConfirm"
import { useResourceDetail } from "@/hooks/use-resource-detail"
import { MarkdownPreview } from "./MarkdownPreview"

const typeIcon: Record<ResourceType, React.ComponentType<{ className?: string }>> = {
  skill: BrainCircuit,
  agent: Cog,
  workflow: Workflow,
}

const PRIMARY_FILE: Record<string, string[]> = {
  skill: ["SKILL.md"],
  agent: ["AGENT.md", "agent.md"],
  workflow: ["workflow.yaml", "workflow.yml"],
}

function fileIcon(path: string) {
  if (path.endsWith(".md")) return FileText
  if (/\.(ts|tsx|js|jsx|py|sh|yaml|yml|json)$/.test(path)) return FileCode
  return File
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function ResourceDetail() {
  const params = useParams()
  const router = useRouter()
  const type = params.type as string
  const name = params.name as string

  const { resource: entry, loading, error } = useResourceDetail(type, name)
  const [showUninstall, setShowUninstall] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)

  // File viewer state
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)

  // Load file list
  const loadFiles = useCallback(async () => {
    if (!type || !name) return
    try {
      const res = await getResourceFiles(type, name)
      if ("files" in res) {
        setFiles(res.files)
        // Auto-select primary file
        const primaries = PRIMARY_FILE[type] || []
        const primary = res.files.find((f) => primaries.includes(f.path))
        if (primary) setSelectedFile(primary.path)
        else if (res.files.length > 0) setSelectedFile(res.files[0].path)
      }
    } catch {
      // Files may not exist for this resource
    }
  }, [type, name])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedFile || !type || !name) return
    setFileLoading(true)
    setFileContent(null)
    getResourceFiles(type, name, selectedFile)
      .then((res) => {
        if ("content" in res) setFileContent(res.content)
      })
      .catch(() => setFileContent(null))
      .finally(() => setFileLoading(false))
  }, [type, name, selectedFile])

  const handleUninstall = async () => {
    if (!entry) return
    setUninstalling(true)
    try {
      await uninstallResource(entry.name, entry.type)
      toast.success(`资源 ${entry.name} 已卸载`)
      router.push("/resources")
    } catch {
      setShowUninstall(false)
      setUninstalling(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground" role="status">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  if (error || !entry) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
        {error || "资源不存在"}
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/resources">← 返回列表</Link>
          </Button>
        </div>
      </div>
    )
  }

  const Icon = typeIcon[entry.type as ResourceType] || BrainCircuit

  return (
    <div aria-label="资源详情">
      <Link
        href="/resources"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回列表
      </Link>

      {/* Header */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <Icon className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold" title={entry.name}>{entry.name}</h2>
                <Badge variant="outline">{entry.type}</Badge>
                {entry.status === "installed" ? (
                  <Badge variant="secondary" className="gap-1 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    已安装
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-amber-600">
                    <AlertTriangle className="h-3 w-3" />
                    未验证
                  </Badge>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-4 text-sm text-muted-foreground">
                <span>{entry.source}: <code className="text-xs">{entry.ref}</code></span>
                {entry.installPath && (
                  <span className="font-mono text-xs">{entry.installPath}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {entry.installed && (
              <Button variant="destructive" size="sm" onClick={() => setShowUninstall(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                卸载
              </Button>
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <div>
            <span className="text-muted-foreground">安装时间</span>
            <span className="ml-1.5 font-medium">{new Date(entry.installedAt).toLocaleDateString("zh-CN")}</span>
          </div>
          {entry.dependsOn && entry.dependsOn.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">依赖</span>
              {entry.dependsOn.map((dep) => (
                <Badge key={dep} variant="secondary" className="text-xs">{dep}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* File Explorer */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex border-b border-border">
          {/* Sidebar — file tree */}
          <div className="w-56 shrink-0 border-r border-border p-2">
            <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">
              文件 ({files.length})
            </div>
            {files.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">无文件</p>
            ) : (
              <nav className="space-y-0.5">
                {files.map((f) => {
                  const FileIcon = fileIcon(f.path)
                  const isActive = selectedFile === f.path
                  const isPrimary = (PRIMARY_FILE[type] || []).includes(f.path)
                  return (
                    <button
                      key={f.path}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                      title={f.path}
                      onClick={() => setSelectedFile(f.path)}
                    >
                      <FileIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate flex-1">{f.path}</span>
                      {isPrimary && (
                        <span className="shrink-0 text-[9px] font-bold uppercase text-primary">main</span>
                      )}
                    </button>
                  )
                })}
              </nav>
            )}
          </div>

          {/* Content area */}
          <div className="flex-1 min-w-0">
            {fileLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                加载中...
              </div>
            ) : selectedFile && fileContent !== null ? (
              <div>
                {/* File header */}
                <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm font-medium">{selectedFile}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatSize(fileContent.length)}
                  </span>
                </div>
                {/* File body */}
                <div className="max-h-[70vh] overflow-auto p-4">
                  {selectedFile.endsWith(".md") ? (
                    <MarkdownPreview content={fileContent} />
                  ) : (
                    <pre className="overflow-x-auto rounded-md bg-muted p-4 text-sm">
                      <code>{fileContent}</code>
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                选择文件查看内容
              </div>
            )}
          </div>
        </div>
      </div>

      <UninstallConfirm
        open={showUninstall}
        onOpenChange={setShowUninstall}
        name={entry.name}
        type={entry.type as ResourceType}
        onConfirm={handleUninstall}
        loading={uninstalling}
      />
    </div>
  )
}
