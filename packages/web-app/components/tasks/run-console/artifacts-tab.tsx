// packages/web-app/components/tasks/run-console/artifacts-tab.tsx
//
// 票 11 ⑩回补 — ▣ 产物页签：server 分组清单（GET /:id/artifacts/manifest）按组
// 分列渲染，行带「▶ 预览」（对话框现读文本，走 manifest/content 守卫门）与
// 「⧉ 路径」（复制引用路径）。产物 ≠ diff：代码改动看「≡ 变更」，这里列
// 规格 / 票 / 报告 / 证据 / 台账 / 原型（原型 artifactsHtml 顶注口径）。

"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { readArtifactManifestFile, type ArtifactContent } from "@/lib/tasks-api"
import { artifactSizeText, previewTruncate, type ArtifactManifestBody, type ArtifactManifestItem } from "./artifacts-model"

const PREVIEW_MAX = 20_000

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
            <div className="space-y-1">
              {g.items.map((item) => (
                <div
                  key={item.path}
                  data-testid="artifact-row"
                  data-artifact-key={item.path}
                  className="flex flex-wrap items-center gap-x-2 rounded-md border border-border bg-pop-idle/40 px-2.5 py-1.5 text-[11.5px]"
                >
                  <span className="min-w-0 max-w-[220px] truncate font-semibold" title={item.name}>{item.name}</span>
                  <span className="min-w-0 max-w-[280px] truncate font-mono text-[10px] text-muted-foreground" title={item.path}>{item.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-pop-dim">{artifactSizeText(item.bytes)}</span>
                  <button
                    onClick={() => setPreview(item)}
                    data-testid="artifact-preview-btn"
                    className="ml-auto shrink-0 rounded border-[1.5px] border-pop-bd bg-pop-paper px-1.5 py-px font-mono text-[10px] font-black text-pop-dim transition-colors hover:border-pop-bd hover:text-pop-ink"
                    title="对话框现读文本（守卫门：白名单区内、超上限拒读）"
                  >
                    ▶ 预览
                  </button>
                  <button
                    onClick={() => { void copyPath(item) }}
                    data-testid="artifact-copy-btn"
                    className="shrink-0 rounded border-[1.5px] border-pop-bd bg-pop-paper px-1.5 py-px font-mono text-[10px] font-black text-pop-dim transition-colors hover:border-pop-bd hover:text-pop-ink"
                    title="复制产物引用路径"
                  >
                    ⧉ 路径
                  </button>
                </div>
              ))}
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
