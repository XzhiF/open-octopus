'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatArea } from '@/components/agent/chat/ChatArea'
import { useAgentChat, type UseAgentChatApiOverride } from '@/hooks/useAgentChat'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useKcFindings } from '@/hooks/use-kc-findings'
import { KcCard, type KcCardActionCtx } from './cards/registry'
import {
  createCloneSession,
  getCloneSession,
  getCloneSessionRunning,
  listCloneSessions,
  cloneChatStream,
  stopCloneChat,
} from '@/lib/agent/api'
import type { AgentMessage } from '@/lib/agent/types'
import {
  parseKcCardBlocks,
  kcEventPageRefs,
  type KcBackfillCardData,
  type KcCardEvent,
  type KcCompileDiffCardData,
  type KcFindingCardData,
} from '@/lib/knowledge-center/card-protocol'
import { classifyKcFeed } from '@/lib/knowledge-center/feed-protocol'
import type { KcTree } from '@/lib/knowledge/knowledge-center-api'

/**
 * 知识中心对话列（票12 主接线板 + 票13 findings/回填接线）。
 *
 * 零自建聊天基建：会话通道 = archive 分身（策展人）既有 clone-session API
 * （CloneDetailView 同款 overrides：getSession/chatStream/stopChat/checkRunning），
 * 流式渲染 = <ChatArea tui>（TuiTranscript 形制复用）；knowledge 语义走
 * createCloneSession(scope_id="knowledge") + 固定标题通道。
 *
 * 卡片两车道（协议契约见 @octopus/shared card-protocol，web 侧垫片 re-export）：
 *  - Lane A：消息正文 fenced kc-card 块 → messageExtras 交错渲染（正文剥块）；
 *  - Lane B：投喂/编译/回滚任务卡（use-kc-feed）+ 开放 findings 卡（use-kc-findings）
 *    → transcriptTail，按 sessionId 侧挂 localStorage `kc-cards:{sessionId}` 沉淀；
 *    同 id 事件 Lane A 优先。fix/backfill 覆盖层合并进任意来源卡（与 revertStates 同构）。
 * 对话内投喂：classifyKcFeed 命中 → REST 执行面（ingest?compile=true）+ 原文
 * 照常发策展人（对话面，策展人接话/讨论）；未命中 → 纯对话。
 * 「体检一下」（票13 即时触发）：识别 → POST /patrol（服务层同步五查）→ 开放
 * findings 重载进卡流；原文照常发策展人（对话不劫持）。
 */

const ARCHIVE_CLONE = 'archive'
const KC_SESSION_TITLE = '知识中心'

/** Lane B 侧挂沉淀（异常静默：无痕模式/配额不炸对话）。 */
function loadPersistedCards(sessionId: string | null): KcCardEvent[] {
  if (!sessionId) return []
  try {
    const raw = localStorage.getItem(`kc-cards:${sessionId}`)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { v?: number; cards?: unknown }
    if (parsed.v !== 1 || !Array.isArray(parsed.cards)) return []
    return parsed.cards.filter((c): c is KcCardEvent => !!c && typeof c === 'object' && typeof (c as KcCardEvent).id === 'string' && typeof (c as KcCardEvent).kind === 'string')
  } catch {
    return []
  }
}

function persistCards(sessionId: string | null, cards: KcCardEvent[]): void {
  if (!sessionId) return
  try {
    localStorage.setItem(`kc-cards:${sessionId}`, JSON.stringify({ v: 1, cards }))
  } catch { /* 静默 */ }
}

export interface ChatColumnProps {
  tree: KcTree | null
  /** 右栏渲染跟随页（入参 = 解析后的页 id） */
  onOpenPage: (pageId: string) => void
  /** 全页打开 = 切浏览模式并渲染 */
  onOpenFullPage: (pageId: string) => void
  /** 右栏渲染 raw 源（知识根相对指针路径） */
  onOpenRaw: (pointerPath: string) => void
  /** 编译/回滚落定后刷新（tree/health 重取） */
  onWikiChanged: () => void
  /** 钉住态：true=右栏停跟随 */
  pinned: boolean
  /** 测试/性能注：Lane B 轮询间隔 */
  feedPollMs?: number
}

export function ChatColumn({ tree, onOpenPage, onOpenFullPage, onOpenRaw, onWikiChanged, pinned, feedPollMs }: ChatColumnProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [composerSeed, setComposerSeed] = useState('')
  const activeSessionRef = useRef<string | null>(null)
  activeSessionRef.current = activeSessionId

  // ── clone-session 通道复用（CloneDetailView:53-60 同款 overrides）──
  const chatApi: UseAgentChatApiOverride = useMemo(() => ({
    getSession: (id, query) => getCloneSession(ARCHIVE_CLONE, id, query),
    chatStream: (id, message, o) => cloneChatStream(ARCHIVE_CLONE, id, message, { model: o?.model, subagents: o?.subagents }),
    stopChat: (id) => stopCloneChat(ARCHIVE_CLONE, id),
    checkRunning: (id) => getCloneSessionRunning(ARCHIVE_CLONE, id),
  }), [])

  const chat = useAgentChat(activeSessionId, { api: chatApi })
  const { loadMessages } = chat

  // ── 会话通道：优先沿用「知识中心」标题分身会话，无则建（scope=knowledge 语义）──
  const ensureSession = useCallback(async () => {
    try {
      const res = await listCloneSessions(ARCHIVE_CLONE, { limit: 50 })
      const items = res.sessions ?? []
      let s = items.find(x => x.title === KC_SESSION_TITLE)
      if (!s) s = await createCloneSession(ARCHIVE_CLONE, { title: KC_SESSION_TITLE, scope_id: 'knowledge' })
      if (!activeSessionRef.current) setActiveSessionId(s.id)
    } catch {
      // 服务不可达：对话列显形空会话（不伪造），既有 error 面在 ChatArea
    }
  }, [])

  useEffect(() => { void ensureSession() }, [ensureSession])
  useEffect(() => { if (activeSessionId) loadMessages() }, [activeSessionId, loadMessages])

  // ── Lane B：投喂/编译/回滚编排 ──
  const feed = useKcFeed({ pollMs: feedPollMs, onSettled: onWikiChanged })
  const { restore } = feed

  // ── 票13：开放 findings（进入页面/体检后重载）+ 裁决/回填覆盖层 ──
  const findings = useKcFindings({
    pollMs: feedPollMs,
    onSettled: onWikiChanged,
    onBackfillCompile: (taskId, rawPath) => feed.trackTask(taskId, rawPath),
  })
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = activeSessionId

  const handleCreateSession = useCallback(async () => {
    try {
      const s = await createCloneSession(ARCHIVE_CLONE, { title: KC_SESSION_TITLE, scope_id: 'knowledge' })
      setActiveSessionId(s.id)
      feed.reset()
    } catch { /* 非致命 */ }
  }, [feed.reset])

  // 会话切换 ⇒ 载侧挂沉淀。首拍 persist 跳过（restore 的 setState 与 persist effect
  // 同一提交竞态：不跳则空 cards 覆写既有沉淀）。
  const skipNextPersistRef = useRef(false)
  useEffect(() => {
    restore(loadPersistedCards(activeSessionId))
    skipNextPersistRef.current = true
  }, [activeSessionId, restore])
  useEffect(() => {
    if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return }
    persistCards(activeSessionId, feed.cards)
  }, [activeSessionId, feed.cards])

  // ── Lane A：从消息正文剥 fenced kc-card 块 ──
  const { viewMessages, laneAByMsgId, laneAIds } = useMemo(() => {
    const byMsgId = new Map<string, KcCardEvent[]>()
    const ids = new Set<string>()
    const vm = chat.messages.map((m): AgentMessage => {
      if (!m.content || !m.content.includes('kc-card')) return m
      const { events, rest } = parseKcCardBlocks(m.content)
      if (events.length === 0) return m
      byMsgId.set(m.id, events)
      for (const e of events) ids.add(e.id)
      return { ...m, content: rest }
    })
    return { viewMessages: vm, laneAByMsgId: byMsgId, laneAIds: ids }
  }, [chat.messages])

  // 合并渲染序（ts 升序；同 id Lane A 优先）；回滚/裁决/回填态覆盖层回灌到任意来源卡
  const withCardStates = useCallback((e: KcCardEvent): KcCardEvent => {
    if (e.kind === 'compile-diff' || e.kind === 'archive-compile') {
      const d = e.data as KcCompileDiffCardData
      if (!d.commit || d.revert || !feed.revertStates[d.commit]) return e
      return { ...e, data: { ...d, revert: feed.revertStates[d.commit] } }
    }
    if (e.kind === 'finding') {
      const d = e.data as KcFindingCardData
      const status = findings.findingStatus[d.findingId] ?? d.status
      const fix = findings.fixStates[d.findingId]
      if (!fix && status === d.status) return e
      return { ...e, data: { ...d, ...(fix ? { fix } : {}), status } }
    }
    if (e.kind === 'backfill') {
      const overlay = findings.backfillStates[e.id]
      if (!overlay) return e
      return { ...e, data: { ...e.data as KcBackfillCardData, ...overlay } }
    }
    return e
  }, [feed.revertStates, findings.fixStates, findings.backfillStates, findings.findingStatus])
  const isDismissed = useCallback((e: KcCardEvent) => e.kind === 'backfill' && !!findings.dismissed[e.id], [findings.dismissed])
  const tailEvents = useMemo(
    () => feed.cards
      .concat(findings.cards)
      .filter(e => !laneAIds.has(e.id))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map(withCardStates)
      .filter(e => !isDismissed(e)),
    [feed.cards, findings.cards, laneAIds, withCardStates, isDismissed],
  )

  // ── 右栏跟随（钉住=停；每卡只触发一次，锚事件 id）──
  const lastFollowedRef = useRef<string | null>(null)
  useEffect(() => {
    if (pinned) return
    const all = [...laneAByMsgId.values()].flat().concat(tailEvents).sort((a, b) => a.ts.localeCompare(b.ts))
    for (const e of all.slice().reverse()) {
      if (lastFollowedRef.current === e.id) break
      const refs = kcEventPageRefs(e)
      if (refs.length === 0) continue
      const hit = resolveKcPageTarget(tree, refs[0])
      if (hit) {
        lastFollowedRef.current = e.id
        onOpenPage(hit)
        return
      }
    }
  }, [pinned, laneAByMsgId, tailEvents, tree, onOpenPage])

  // ── 卡动作上下文 ──
  const ctx: KcCardActionCtx = useMemo(() => ({
    openPage: target => { const id = resolveKcPageTarget(tree, target); if (id) onOpenPage(id) },
    openFullPage: target => { const id = resolveKcPageTarget(tree, target); if (id) onOpenFullPage(id) },
    openRaw: pointerPath => onOpenRaw(pointerPath),
    revert: commit => void feed.revert(commit),
    sayToCurator: text => setComposerSeed(text),
    adoptFinding: fid => void findings.adopt(fid),
    ignoreFinding: fid => void findings.ignore(fid),
    backfillWiki: (cardId, input) => void findings.backfill(cardId, {
      ...input,
      sessionId: input.sessionId ?? sessionIdRef.current ?? undefined,
    }),
    dismissBackfill: cardId => findings.dismissBackfill(cardId),
  }), [tree, onOpenPage, onOpenFullPage, onOpenRaw, feed.revert, findings.adopt, findings.ignore, findings.backfill, findings.dismissBackfill])

  // ── 发送：投喂意图走 REST 执行面；「体检一下」走巡检面；对话面原文照常发策展人 ──
  const handleSend = useCallback((message: string) => {
    const intent = classifyKcFeed(message)
    if (intent) void feed.feed(intent)
    if (!intent && /体检|巡检/.test(message)) void findings.patrol()
    if (intent?.mode === 'text') {
      chat.sendMessage(`刚投喂了一段文本素材（${intent.text.length} 字），已落 raw 待编译——请知悉并纳入下轮巡检。`)
    } else {
      chat.sendMessage(message)
    }
  }, [chat.sendMessage, feed.feed, findings.patrol])

  const extras = useCallback((msg: AgentMessage) => {
    const events = laneAByMsgId.get(msg.id)
    if (!events || events.length === 0) return null
    return events
      .filter(e => !isDismissed(e))
      .map(e => <KcCard key={e.id} event={withCardStates(e)} ctx={ctx} />)
  }, [laneAByMsgId, ctx, withCardStates, isDismissed])

  const tail = tailEvents.length > 0
    ? <div data-testid="kc-feed-tail">{tailEvents.map(e => <KcCard key={e.id} event={e} ctx={ctx} />)}</div>
    : null

  return (
    <div data-testid="kc-chat-column" className="flex min-h-0 flex-col border-r-[1.5px] border-pop-bd bg-pop-idle">
      <div className="flex shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-bg px-3 py-1.5 text-[11px] font-bold text-pop-dim">
        <span className="text-pop-green">●</span>
        <span className="text-pop-ink">策展人 · archive 分身会话通道</span>
        <button
          type="button"
          onClick={handleCreateSession}
          data-testid="kc-new-session"
          className="ml-auto rounded border-[1.5px] border-pop-bd bg-pop-paper px-2 py-0.5 hover:bg-accent hover:text-pop-ink"
        >
          新建对话
        </button>
      </div>
      <ChatArea
        tui
        messages={viewMessages}
        streaming={chat.streaming}
        streamContent={chat.streamContent}
        streamThinking={chat.streamThinking}
        isThinking={chat.isThinking}
        toolCalls={chat.toolCalls}
        streamTimeline={chat.streamTimeline}
        pendingConfirm={chat.pendingConfirm}
        error={chat.error}
        statusMessage={chat.statusMessage}
        onSend={handleSend}
        onStop={chat.stopGenerate}
        onConfirm={chat.handleConfirm}
        hasSession={!!activeSessionId}
        currentCloneName={ARCHIVE_CLONE}
        emptyStateTitle="对话即管理"
        emptyStateDescription="投喂 raw（URL/粘贴/路径）、问问题、改页、回滚——管理就是说话。卡片协议沉淀每次操作。"
        composerPlaceholder="投喂 raw（URL/粘贴/路径）· 问问题 · 改页 · 「体检一下」…"
        composerSeed={composerSeed}
        messageExtras={extras}
        transcriptTail={tail}
        contextUsage={chat.contextUsage}
        sessionUsage={null}
      />
    </div>
  )
}

/** 页目标解析（票11 page.resolveLink 同律：id 直配 → path 直配 → 尾段配）。 */
export function resolveKcPageTarget(tree: KcTree | null, target: string): string | null {
  if (!tree) return null
  const entries = tree.domains.flatMap(d => d.entries)
  const t = target.replace(/^wiki\//, '').replace(/\.md$/, '')
  const hit =
    entries.find(e => e.id === target) ??
    entries.find(e => e.path === target || e.path === `${target}.md`) ??
    entries.find(e => e.path.replace(/\.md$/, '') === t || e.path.endsWith(`/${t}`))
  return hit?.id ?? null
}
