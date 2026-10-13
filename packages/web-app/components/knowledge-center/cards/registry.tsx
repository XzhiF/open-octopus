'use client'

import type { ComponentType } from 'react'
import type { KcCardEvent } from '@/lib/knowledge-center/card-protocol'
import { CardShell, CardRow } from './card-shell'
// 首批卡件（import 副作用即注册；票13 照此新增文件 + registerKcCardRenderer 一行）
import { IngestCard } from './ingest-card'
import { SourceSummaryCard } from './source-summary-card'
import { CompileDiffCard } from './compile-diff-card'
import { ArchiveCompileCard } from './archive-compile-card'
import { PageMiniCard } from './page-mini-card'
import { GuardCard } from './guard-card'

/**
 * 卡片渲染注册表（票12「协议=结构化事件→渲染，可扩展」的唯一分发点）。
 *
 * **票13 追加接位（唯一需要做的事）**：
 *   import { registerKcCardRenderer } from "./registry"
 *   registerKcCardRenderer("finding", FindingCard)      // data 接口定义进 card-protocol.ts
 *   registerKcCardRenderer("backfill", BackfillCard)
 * ——KcCard 分发器与本文件不为新卡类改代码；未注册 kind 渲染通用兜底卡（显形不炸流）。
 */
export interface KcCardActionCtx {
  /** 右栏渲染/跟随（入参 = 页 id 或 wiki 相对路径，宿主解析） */
  openPage: (target: string) => void
  /** 全页打开 = 切浏览模式并渲染该页 */
  openFullPage: (target: string) => void
  /** 右栏渲染 raw 源文件（入参 = 知识根相对指针路径 raw/…） */
  openRaw: (pointerPath: string) => void
  /** 回滚（diff 卡二次确认后调用；宿主发 POST /revert 并回流状态到卡） */
  revert: (commit: string) => void
  /** 把文本灌进取号器并发送（归档编译卡「对策展人说」/票13 讨论钮） */
  sayToCurator: (text: string) => void
}

export interface KcCardViewProps {
  event: KcCardEvent
  ctx: KcCardActionCtx
}

type Renderer = ComponentType<KcCardViewProps>

const renderers = new Map<string, Renderer>()

export function registerKcCardRenderer(kind: string, renderer: Renderer): void {
  renderers.set(kind, renderer)
}

export function hasKcCardRenderer(kind: string): boolean {
  return renderers.has(kind)
}

/** 分发器：注册表查渲染件；未知 kind → 通用兜底（票13 卡件未注册期间也不空白）。 */
export function KcCard({ event, ctx }: KcCardViewProps) {
  const Renderer = renderers.get(event.kind)
  if (!Renderer) return <UnknownKcCard event={event} />
  return <Renderer event={event} ctx={ctx} />
}

import { CardShell, CardRow } from './card-shell'

function UnknownKcCard({ event }: { event: KcCardEvent }) {
  return (
    <CardShell testId="unknown" title={`🃏 未注册卡类 · ${event.kind}`} tone="warn">
      <CardRow k="事件 id" v={event.id} tone="muted" />
      <CardRow
        k="数据"
        v={<pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{JSON.stringify(event.data, null, 1)}</pre>}
        tone="muted"
      />
    </CardShell>
  )
}

// ── 首批注册（票12 六类；卡件 import 在文件头，副作用即注册）──
registerKcCardRenderer('ingest', IngestCard)
registerKcCardRenderer('source-summary', SourceSummaryCard)
registerKcCardRenderer('compile-diff', CompileDiffCard)
registerKcCardRenderer('archive-compile', ArchiveCompileCard)
registerKcCardRenderer('page-mini', PageMiniCard)
registerKcCardRenderer('guard', GuardCard)
