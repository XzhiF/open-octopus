'use client'

import type { ComponentType } from 'react'
import type { KcCardEvent } from '@/lib/knowledge-center/card-protocol'
import { CardShell, CardRow } from './card-shell'
// 卡件（import 副作用即注册；新卡类照此新增文件 + registerKcCardRenderer 一行）
import { IngestCard } from './ingest-card'
import { SourceSummaryCard } from './source-summary-card'
import { CompileDiffCard } from './compile-diff-card'
import { ArchiveCompileCard } from './archive-compile-card'
import { PageMiniCard } from './page-mini-card'
import { GuardCard } from './guard-card'
import { FindingCard } from './finding-card'
import { BackfillCard } from './backfill-card'
import { MaterialPackCard } from './material-pack-card'
import { CaseCard } from './case-card'
import { SkillDraftCard } from './skill-draft-card'
import { PageRetireCard } from './page-retire-card'

/**
 * 卡片渲染注册表（票12「协议=结构化事件→渲染，可扩展」的唯一分发点）。
 * 票13 追加 finding/backfill 两卡 = 本文件各一行注册；未注册 kind 渲染通用兜底卡
 * （显形不炸流）。
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
  /** 重试编译（D-kc15-1 票07 抓取卡）：failed 任务再触发——宿主发 POST /wiki/compile 同
   *  rawPath（ingest-compile 队列通道复用，红线2 禁直写），新任务态回灌该卡 */
  retryCompile: (cardId: string, rawPath: string) => void
  /** 把文本灌进取号器并发送（归档编译卡「对策展人说」/finding 讨论钮） */
  sayToCurator: (text: string) => void
  /** [采纳修订]（票13 finding 卡）：POST adopt → 修订稿经全局队列编译，状态回灌卡 */
  adoptFinding: (findingId: string) => void
  /** [忽略]（票13 finding 卡）：POST ignore → 记录在案不再扰 */
  ignoreFinding: (findingId: string) => void
  /** [编进 wiki]（票13 回填卡）：POST /backfill → 摘录落 raw + 编译投递 + diff 卡跟随 */
  backfillWiki: (cardId: string, input: { text: string; title?: string; sessionId?: string }) => void
  /** [不用]（票13 回填卡）：纯前端弃卡，零请求 */
  dismissBackfill: (cardId: string) => void
  /** [剔除重编译]（P3 票02 素材包卡）：POST pack/recompile → 全局串行队列，状态回灌卡 */
  recompilePack: (taskId: string, input: { excludePath?: string; focus?: string }) => void
  /** [退役]（P3 票03 判例卡）：POST /wiki/case/retire → case-archive 队列标 superseded，状态回灌卡 */
  retireCase: (caseId: string) => void
  /** 页退役（票08 · 故事32）：对话退役意图触发 POST /retire（卡上无此钮，仅宿主调用） */
  retirePage?: (pagePath: string) => void
  /** [授予]（P3 票05 草案卡）：POST /drafts/:name/grant {cloneName}（cloneName='*' 授所有分身=共享层） */
  grantDraft?: (draftName: string, cloneName: string) => void
  /** [撤销]（P3 票05 草案卡）：POST /drafts/:name/revoke {cloneName}（逆链=目录删+预置源+版本回退） */
  revokeDraft?: (draftName: string, cloneName: string) => void
  /** 可授予分身清单（票05 选择器数据源，宿主 GET /api/clones 一次拉取；空=诚实降级只剩「所有分身」） */
  grantTargets?: Array<{ name: string; display_name: string }>
  /** 清单拉取错误（aa-fix 项6）：非空=服务不可达——卡面显形，不把故障伪装成「确无分身」 */
  grantTargetsError?: string | null
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

// ── 注册（票12 六类 + 票13 finding/backfill + P3 票02 material-pack + P3 票03 case + P3 票08 page-retire + P3 票04 skill-draft；卡件 import 在文件头，副作用即注册）──
registerKcCardRenderer('ingest', IngestCard)
registerKcCardRenderer('source-summary', SourceSummaryCard)
registerKcCardRenderer('compile-diff', CompileDiffCard)
registerKcCardRenderer('archive-compile', ArchiveCompileCard)
registerKcCardRenderer('page-mini', PageMiniCard)
registerKcCardRenderer('guard', GuardCard)
registerKcCardRenderer('finding', FindingCard)
registerKcCardRenderer('backfill', BackfillCard)
registerKcCardRenderer('material-pack', MaterialPackCard)
registerKcCardRenderer('case', CaseCard)
// P3 票04：skill 草案卡——一行注册（红线4：本卡只到预览/改写/溯源，授予钮=票05 扩展位）
registerKcCardRenderer('skill-draft', SkillDraftCard)
// 票08 清理账（故事32）：页退役卡——一行注册（开放 kind，无 KcCardKind 联合改动）
registerKcCardRenderer('page-retire', PageRetireCard)
