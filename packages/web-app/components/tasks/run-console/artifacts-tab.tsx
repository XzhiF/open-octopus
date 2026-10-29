// packages/web-app/components/tasks/run-console/artifacts-tab.tsx
//
// 票 11 ⑩回补 — ▣ 产物页签：server 分组清单（GET /:id/artifacts/manifest）按组
// 分列渲染，行带「▶ 预览」（对话框现读文本，走 manifest/content 守卫门）与
// 「⧉ 路径」（复制引用路径）。产物 ≠ diff：代码改动看「≡ 变更」，这里列
// 规格 / 票 / 报告 / 证据 / 台账 / 原型（原型 artifactsHtml 顶注口径）。

"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { readArtifactManifestFile, type ArtifactContent } from "@/lib/tasks-api"
import { formatBytes } from "@/lib/format"
import type { ArtifactManifestBody, ArtifactManifestItem } from "@/lib/types"
import { previewTruncate } from "./artifacts-model"

const PREVIEW_MAX = 20_000

/** 门牌前缀 → 树根名（home: 任务 home / ws: 工作区）。 */
const ROOT_LABEL: Record<string, string> = { 'home:': '任务目录', 'ws:': '工作区' }

interface TreeNode {
  name: string
  dir: boolean
  /** 文件才有：原始引用路径（home:… / ws:…）。 */
  path?: string
  item?: ArtifactManifestItem
  children: TreeNode[]
}

/** 把 `home:.scratch/a/b.md` / `ws:public/x.html` 折成目录树（2026-10-29 用户：
 *  产物要按目录树/文件展示，而不是平铺清单）。 */
export function buildArtifactTree(items: readonly ArtifactManifestItem[]): TreeNode[] {
  const roots: TreeNode[] = []
  const insert = (nodes: TreeNode[], parts: string[], item: ArtifactManifestItem): void => {
    const [head, ...rest] = parts
    if (!head) return
    const dir = rest.length > 0
    let node = nodes.find((n) => n.name === head && n.dir === dir)
    if (!node) {
      node = { name: head, dir, children: [] }
      nodes.push(node)
    }
    if (!dir) {
      node.item = item
      node.path = item.path
      return
    }
    insert(node.children, rest, item)
  }
  for (const item of items) {
    const m = item.path.match(/^([a-z]+:)(.*)$/)
    const prefix = m ? m[1] : ''
    const rest = (m ? m[2] : item.path).split(/[\\/]+/).filter(Boolean)
    insert(roots, [prefix, ...rest], item)
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const n of nodes) sort(n.children)
  }
  sort(roots)
  return roots
}

function TreeNodes({ nodes, onPreview, onCopy }: {
  nodes: TreeNode[]
  onPreview: (item: ArtifactManifestItem) => void
  onCopy: (item: ArtifactManifestItem) => void
}) {
  return (
    <>
      {nodes.map((node) => node.dir || !node.item
        ? <TreeFolder key={`d:${node.name}`} node={node} onPreview={onPreview} onCopy={onCopy} />
        : <TreeFile key={node.item.path} item={node.item} onPreview={onPreview} onCopy={onCopy} />)}
    </>
  )
}

function TreeFolder({ node, onPreview, onCopy }: {
  node: TreeNode
  onPreview: (item: ArtifactManifestItem) => void
  onCopy: (item: ArtifactManifestItem) => void
}) {
  const [open, setOpen] = useState(true)
  const label = ROOT_LABEL[node.name] ?? node.name
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="artifact-folder"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] text-pop-dim transition-colors hover:bg-white/[0.04] hover:text-pop-ink"
        title={node.name}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {open
          ? <FolderOpen className="size-3.5 shrink-0 text-pop-amber" strokeWidth={1.8} />
          : <Folder className="size-3.5 shrink-0 text-pop-amber" strokeWidth={1.8} />}
        <span className="truncate font-medium">{label}</span>
      </button>
      {open && (
        <div className="ml-2.5 border-l border-white/[0.07] pl-2">
          <TreeNodes nodes={node.children} onPreview={onPreview} onCopy={onCopy} />
        </div>
      )}
    </div>
  )
}

function TreeFile({ item, onPreview, onCopy }: {
  item: ArtifactManifestItem
  onPreview: (item: ArtifactManifestItem) => void
  onCopy: (item: ArtifactManifestItem) => void
}) {
  return (
    <div
      data-testid="artifact-row"
      data-artifact-key={item.path}
      className="group flex flex-wrap items-center gap-x-2 rounded px-1.5 py-1 text-[11.5px] transition-colors hover:bg-white/[0.04]"
    >
      <FileText className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.7} />
      <span className="min-w-0 max-w-[300px] truncate font-semibold text-pop-ink/90" title={item.path}>{item.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-pop-dim">{formatBytes(item.bytes)}</span>
      <span className="ml-auto flex shrink-0 gap-1">
        <button
          onClick={() => onPreview(item)}
          data-testid="artifact-preview-btn"
          className="rounded border-[1.5px] border-pop-bd bg-pop-paper px-1.5 py-px font-mono text-[10px] font-black text-pop-dim transition-colors hover:border-pop-bd hover:text-pop-ink"
          title="对话框现读文本（守卫门：白名单区内、超上限拒读）"
        >
          ▶ 预览
        </button>
        <button
          onClick={() => { void onCopy(item) }}
          data-testid="artifact-copy-btn"
          className="rounded border-[1.5px] border-pop-bd bg-pop-paper px-1.5 py-px font-mono text-[10px] font-black text-pop-dim transition-colors hover:border-pop-bd hover:text-pop-ink"
          title="复制产物引用路径"
        >
          ⧉ 路径
        </button>
      </span>
    </div>
  )
}

function ArtifactTreeSection({ items, onPreview, onCopy }: {
  items: ArtifactManifestItem[]
  onPreview: (item: ArtifactManifestItem) => void
  onCopy: (item: ArtifactManifestItem) => void
}) {
  const tree = useMemo(() => buildArtifactTree(items), [items])
  return <TreeNodes nodes={tree} onPreview={onPreview} onCopy={onCopy} />
}

export function ArtifactsTab({ taskId, body, loading }: { taskId: string; body: ArtifactManifestBody | null; loading: boolean }) {
  const [preview, setPreview] = useState<ArtifactManifestItem | null>(null)

  const copyPath = async (item: ArtifactManifestItem) => {
    try {
      await navigator.clipboard.writeText(item.path)
      toast.success(`已复制路径 ${item.path}`)
    } catch {
      toast.error("剪贴板不可用 — 路径已在行内可见")
    }
  }

  if (loading && !body) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground" data-testid="artifacts-loading">
        <Spinner className="size-3" /> 产物清单读取中…
      </div>
    )
  }
  const groups = body?.groups ?? []
  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="space-y-3 p-3.5" data-testid="artifacts-tab">
      <div className="flex items-baseline gap-2 text-[10.5px] text-muted-foreground">
        工作区交付物清单 — 产物 ≠ diff：代码改动看「≡ 变更」，这里列规格 / 票 / 报告 / 证据 / 台账 / 原型
        <span className="ml-auto font-mono text-[10px]">数据源：约定目录扫描（缺文件 = 空组）</span>
      </div>
      {total === 0 ? (
        <p className="py-2 text-xs text-muted-foreground" data-testid="artifacts-empty">
          暂无可列产物 —— 批次目录还没落盘（spec/报告/证据写出来即出现）。
        </p>
      ) : (
        groups.filter((g) => g.items.length > 0).map((g) => (
          <section key={g.key} data-testid={`artifacts-group-${g.key}`}>
            <div className="mb-1 font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">{g.label}</div>
            <div className="rounded-md border border-border bg-pop-idle/25 p-1">
              <ArtifactTreeSection items={g.items} onPreview={setPreview} onCopy={copyPath} />
            </div>
          </section>
        ))
      )}
      <ArtifactPreviewDialog taskId={taskId} item={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

/** 预览最小实现：对话框现读文本（manifest/content 守卫门；超 20K 字符截断，
 *  403/404/413 错误原文透出，不白屏）。 */
function ArtifactPreviewDialog({ taskId, item, onClose }: { taskId: string; item: ArtifactManifestItem | null; onClose: () => void }) {
  const [data, setData] = useState<ArtifactContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!item) { setData(null); setError(null); return }
    let cancelled = false
    setBusy(true)
    setError(null)
    readArtifactManifestFile(taskId, item.path)
      .then((r) => { if (!cancelled) setData(r) })
      .catch((err: unknown) => { if (!cancelled) { setData(null); setError(err instanceof Error ? err.message : String(err)) } })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [item, taskId])

  const { text, truncated } = previewTruncate(data?.content ?? "", PREVIEW_MAX)

  return (
    <Dialog open={item !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-[760px] data-[state=open]:animate-in" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {item?.name ?? ""}
            <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">{item?.path}</span>
          </DialogTitle>
        </DialogHeader>
        <div data-testid="artifact-preview-body" className="max-h-[60vh] min-h-[120px] overflow-y-auto rounded-md border border-border bg-pop-idle p-2.5">
          {busy ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> 现读中…</div>
          ) : error ? (
            <p className="text-xs text-pop-red">读取失败（{error}）</p>
          ) : (
            <>
              {truncated && <p className="mb-1 font-mono text-[10px] text-pop-amber">… 超 {PREVIEW_MAX} 字符已截断（复制路径看全文）</p>}
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{text}</pre>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
