// packages/web-app/components/chat-workbench/archive-pack-dialog.tsx
//
// 归档素材件只读预览弹窗（2026-10-31）：与产物窗同款观感 —— .md 走
// MarkdownPreview，.json 美化 + 词法高亮，其余扩展名等宽原文。
// 内容来自知识库 raw 冻结件（GET /api/knowledge/fs/file?path=），
// 只读：不提供剔除 / 重编译按钮，那些操作回主 Chat 或知识中心。

'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { FileText } from 'lucide-react'
import { getKcFsFile } from '@/lib/knowledge/knowledge-center-api'
import { MarkdownPreview, MARKDOWN_TUI_CLASS } from '@/components/resource/MarkdownPreview'
import {
  prettyJsonForPreview, tokenizeJson, type JsonTokenKind,
} from '@/components/tasks/run-console/artifacts-model'
import type { ArchiveKnowledgeItemWire } from '@/lib/tasks-api'

const JSON_TONE: Record<JsonTokenKind, string> = {
  key: 'text-pop-cyan',
  string: 'text-pop-green',
  number: 'text-pop-amber',
  boolean: 'text-pop-purple',
  null: 'text-pop-red',
  punct: 'text-pop-dim',
  plain: 'text-pop-ink/85',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 冻结件正文带 front-matter 五件套；预览只看正文（头信息是冻结凭据，打开原文件可查）。 */
function stripFrontMatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  return text.slice(end + 4).replace(/^\s*\n/, '')
}

type State =
  | { kind: 'loading' }
  | { kind: 'loaded'; content: string }
  | { kind: 'error'; message: string }

export function ArchivePackDialog({
  item,
  onOpenChange,
}: {
  item: ArchiveKnowledgeItemWire | null
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    if (!item) return
    let cancelled = false
    setState({ kind: 'loading' })
    getKcFsFile(item.path)
      .then((res) => { if (!cancelled) setState({ kind: 'loaded', content: res.content }) })
      .catch((err: unknown) => {
        if (!cancelled) setState({
          kind: 'error',
          message: err instanceof Error ? err.message : '读取素材件失败',
        })
      })
    return () => { cancelled = true }
  }, [item])

  const body = state.kind === 'loaded' ? stripFrontMatter(state.content) : ''
  const isMarkdown = /\.(md|markdown)$/i.test(item?.path ?? '')
  const isJson = /\.json$/i.test(item?.path ?? '')
  const formatted = useMemo(() => prettyJsonForPreview(body), [body])
  const tokens = useMemo(() => tokenizeJson(formatted.text), [formatted.text])
  const stats = state.kind === 'loaded'
    ? { lines: body.split('\n').length, chars: body.length }
    : null

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="archive-pack-dialog"
        className="sm:max-w-[760px] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col"
        showCloseButton
      >
        <DialogHeader className="py-3 pl-12 pr-4 border-b shrink-0 space-y-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <FileText className="size-3.5" />
            <span className="truncate">{item?.name ?? ''}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] truncate">
            {item ? `${item.kind} · ${item.path} · ${formatBytes(item.bytes)}` : ''}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          {state.kind === 'loading' ? (
            <div className="flex items-center justify-center gap-2 p-8 text-xs text-pop-dim">
              <Spinner className="size-4" /> 读取素材件…
            </div>
          ) : state.kind === 'error' ? (
            <div className="p-6 text-xs text-pop-red" data-testid="archive-pack-dialog-error">
              {state.message}
            </div>
          ) : isMarkdown ? (
            <div className="p-4" data-testid="archive-pack-markdown">
              <MarkdownPreview content={body} className={MARKDOWN_TUI_CLASS} />
            </div>
          ) : isJson ? (
            <pre
              data-testid="archive-pack-json"
              className="whitespace-pre-wrap break-all p-4 font-mono text-[11px] leading-relaxed"
            >
              {tokens.map((token, i) => (
                <span key={i} data-json-token={token.kind} className={JSON_TONE[token.kind]}>{token.text}</span>
              ))}
            </pre>
          ) : (
            <pre
              data-testid="archive-pack-text"
              className="whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-pop-ink/85"
            >
              {body}
            </pre>
          )}
        </ScrollArea>

        <div className="px-4 py-2 border-t text-[10px] text-pop-dim shrink-0 flex items-center justify-between gap-2">
          <span>只读 · 取自知识库 raw 冻结件；sha256 与冻结头在文件 front-matter 中。</span>
          {stats && (
            <span className="shrink-0 font-mono tabular-nums" data-testid="archive-pack-stats">
              {stats.lines} 行 · {stats.chars} 字
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
