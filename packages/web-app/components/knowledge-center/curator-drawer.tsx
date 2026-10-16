'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatArea } from '@/components/agent/chat/ChatArea'
import { useAgentChat, type UseAgentChatApiOverride } from '@/hooks/useAgentChat'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useKcFindings } from '@/hooks/use-kc-findings'
import { useKcPacks } from '@/hooks/use-kc-packs'
import { useKcCases } from '@/hooks/use-kc-cases'
import { useKcGrants } from '@/hooks/use-kc-grants'
import { KcCard, type KcCardActionCtx } from './cards/registry'
import {
  createCloneSession,
  getCloneSession,
  getCloneSessionRunning,
  listCloneSessions,
  cloneChatStream,
  stopCloneChat,
} from '@/lib/agent/api'
import type { AgentMessage, AgentSession } from '@/lib/agent/types'
import {
  parseKcCardBlocks,
  kcEventPageRefs,
  type KcBackfillCardData,
  type KcCardEvent,
  type KcCompileDiffCardData,
  type KcFindingCardData,
  type KcMaterialPackCardData,
  type KcCaseCardData,
  type KcSkillDraftCardData,
} from '@/lib/knowledge-center/card-protocol'
import { classifyKcFeed, classifyKcRetire, classifyKcRestore } from '@/lib/knowledge-center/feed-protocol'
import type { KcTree } from '@/lib/knowledge/knowledge-center-api'
import { resolveKcPageTarget } from './page-target'
import { cn } from "@/lib/utils"

/**
 * 策展人抽屉 — 知识中心改版（ADR-0033）：对话从「左列 3fr」收纳为右侧 overlay，
 * 开合/拖宽**永不重排 wiki 主场**（这是双模式两套 grid 重排病的根治）。
 *
 * 会话通道 = archive 分身 clone-session（CloneDetailView 同款 overrides），
 * **多会话**：主通道（title=知识中心）恒在 + 手动新建（知识中心 · N）；tab 开集/
 * active/宽度均存 localStorage（纯视图态——clone-session 无删除/归档/改名端点，
 * 也不为此新增；「关闭 tab」= 收起，会话本体在「🗂 历史」可捞回重开）。
 * 历史面 = listCloneSessions(archive, 50) JS 筛 scope/title 同律（chat-column 票12
 * 按 title 找会话的前例；服务端不支持 scope 过滤，零新端点）。
 *
 * 「跟随」已废（ADR-0033）：新卡引用页 ⇒ 上抛 onCite（页头引用药丸），
 * 正文永不自动跳转——负断言对象。卡片两车道协议（Lane A/B）逐字保留票12/13 形制。
 */

const ARCHIVE_CLONE = 'archive'
const PRIMARY_TITLE = '知识中心'
const TABS_KEY = 'kc-dra...'
const ACTIVE_KEY = '***'
const WIDTH_KEY = '***'
const DEFAULT_W = 560
const MIN_W = 420

interface DrawerTab { id: string; title: string }

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* 无痕/配额静默 */ }
}

/** 知识中心域会话判定（与 patrol-job KNOWLEDGE_SESSION_* 语义同律；title ∨ scope）。 */
function isKnowledgeSession(s: AgentSession): boolean {
  return s.scope_id === 'knowledge' || s.title === PRIMARY_TITLE || s.title.startsWith(`${PRIMARY_TITLE} ·`)
}

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

export interface CuratorDrawerProps {
  tree: KcTree | null
  open: boolean
  onClose: () => void
  /** 卡引用页 → 页头药丸（父层持态；点击才 setView） */
  onCite: (pageId: string, cardId: string) => void
  onOpenPage: (pageId: string) => void
  onOpenRaw: (pointerPath: string) => void
  onWikiChanged: () => void
  /** 测试/性能注：Lane B 轮询间隔 */
  feedPollMs?: number
}

export function CuratorDrawer({ tree, open, onClose, onCite, onOpenPage, onOpenRaw, onWikiChanged, feedPollMs }: CuratorDrawerProps) {
  // ── 会话 tab（视图态）──
  const [tabs, setTabs] = useState<DrawerTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [serverSessions, setServerSessions] = useState<AgentSession[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const tabsInitRef = useRef(false)
  const restoredRef = useRef(false) // 恢复完成前禁持久化（否则首渲染 tabs=[] 覆写存档，恢复永失效）
  const activeSessionRef = useRef<string | null>(null)
  activeSessionRef.current = activeId

  // ── 抽屉宽（视图态，localStorage 记忆）──
  const [width, setWidth] = useState(() => {
    const n = Number(lsGet(WIDTH_KEY))
    return n >= MIN_W ? n : DEFAULT_W
  })
  const dragRef = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const max = Math.round(window.innerWidth * 0.94)
      const next = Math.max(MIN_W, Math.min(max, d.w + (d.x - e.clientX)))
      setWidth(next)
      lsSet(WIDTH_KEY, String(next)) // 随拖随存（code-review S4：mouseup 闭包值可能滞后一帧）
    }
    const up = () => { dragRef.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  // ── clone-session 通道复用（CloneDetailView:53-60 同款 overrides）──
  const chatApi: UseAgentChatApiOverride = useMemo(() => ({
    getSession: (id, query) => getCloneSession(ARCHIVE_CLONE, id, query),
    chatStream: (id, message, o) => cloneChatStream(ARCHIVE_CLONE, id, message, { model: o?.model, subagents: o?.subagents }),
    stopChat: (id) => stopCloneChat(ARCHIVE_CLONE, id),
    checkRunning: (id) => getCloneSessionRunning(ARCHIVE_CLONE, id),
  }), [])

  const chat = useAgentChat(activeId, { api: chatApi })
  const { loadMessages } = chat

  // ── Lane B：投喂/编译/回滚编排（先于会话操作声明：新会话需同步 reset 任务卡态，
  //  票12 handleCreateSession feed.reset 同语义——code-review S3 去 ref 间接层） ──
  const feed = useKcFeed({ pollMs: feedPollMs, onSettled: onWikiChanged })
  const { restore } = feed
  const [composerSeed, setComposerSeed] = useState('')

  // ── 会话清单：拉服务端知识域会话 → 恢复 tab 态 → 确保主通道存在 ──
  const refreshSessions = useCallback(async (): Promise<AgentSession[]> => {
    try {
      const res = await listCloneSessions(ARCHIVE_CLONE, { limit: 50 })
      const kc = (res.sessions ?? []).filter(isKnowledgeSession)
      setServerSessions(kc)
      return kc
    } catch {
      return [] // 服务不可达：tab 维持本地态（ChatArea 既有 error 面显形）
    }
  }, [])

  useEffect(() => {
    if (tabsInitRef.current) return
    tabsInitRef.current = true
    void (async () => {
      let kc = await refreshSessions()
      // 主通道恒在：缺席即建（票12 ensureSession 同律，语义升级为「机器播报唯一落点」）。
      // 已知边界（刻意不扩面）：双窗口同秒首开可各建一条 title=知识中心——服务端无 title
      // 唯一约束（加=新端点违决策③「零新端点」）；patrol find 落列表首位（created 降序），
      // 播报落点仍确定。与票12 前态同律，不为幻影竞态上闸。
      if (!kc.some(s => s.title === PRIMARY_TITLE)) {
        try {
          const created = await createCloneSession(ARCHIVE_CLONE, { title: PRIMARY_TITLE, scope_id: 'knowledge' })
          kc = [created, ...kc]
          setServerSessions(kc)
        } catch { /* 不可达：诚实空态 */ }
      }
      const byId = new Map(kc.map(s => [s.id, s]))
      const saved: string[] = (() => {
        try {
          const v: unknown = JSON.parse(lsGet(TABS_KEY) ?? "[]")
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
        } catch { return [] }
      })()
      const openTabs: DrawerTab[] = saved.flatMap(id => { const s = byId.get(id); return s ? [{ id: s.id, title: s.title }] : [] })
      const primary = kc.find(s => s.title === PRIMARY_TITLE)
      if (openTabs.length === 0 && primary) openTabs.push({ id: primary.id, title: primary.title })
      if (openTabs.length === 0 && kc[0]) openTabs.push({ id: kc[0].id, title: kc[0].title })
      setTabs(openTabs)
      const savedActive = lsGet(ACTIVE_KEY)
      const init = openTabs.find(t => t.id === savedActive) ?? openTabs[0]
      setActiveId(init?.id ?? null)
      restoredRef.current = true // 恢复完毕，此后 tab 变更才许落盘
    })()
  }, [refreshSessions])

  useEffect(() => {
    if (!restoredRef.current) return
    lsSet(TABS_KEY, JSON.stringify(tabs.map(t => t.id)))
  }, [tabs])
  useEffect(() => { if (activeId) { lsSet(ACTIVE_KEY, activeId); void loadMessages() } }, [activeId, loadMessages])

  const openTab = useCallback((id: string, title: string) => {
    setTabs(prev => prev.some(t => t.id === id) ? prev : [...prev, { id, title }])
    setActiveId(id)
  }, [])

  const handleNewSession = useCallback(async () => {
    try {
      const res = await listCloneSessions(ARCHIVE_CLONE, { limit: 50 })
      const kc = (res.sessions ?? []).filter(isKnowledgeSession)
      const used = kc.map(s => s.title)
      let n = 1
      while (used.includes(`${PRIMARY_TITLE} · ${n}`)) n++
      const s = await createCloneSession(ARCHIVE_CLONE, { title: `${PRIMARY_TITLE} · ${n}`, scope_id: 'knowledge' })
      setServerSessions(kc.length ? [s, ...kc] : [s])
      openTab(s.id, s.title)
      feed.reset()
    } catch { /* 非致命：ChatArea error 面显形 */ }
  }, [openTab, feed])

  const handleCloseTab = useCallback((id: string) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev // 最后一 tab 不可关（主通道语义保底）
      const next = prev.filter(t => t.id !== id)
      setActiveId(cur => (cur === id ? next[0]?.id ?? null : cur))
      return next
    })
    setHistoryOpen(false)
  }, [])

  const history = useMemo(
    () => serverSessions.filter(s => !tabs.some(t => t.id === s.id)),
    [serverSessions, tabs],
  )

  // ── 票13：开放 findings（进入页面/体检后重载）+ 裁决/回填覆盖层 ──
  const findings = useKcFindings({
    pollMs: feedPollMs,
    onSettled: onWikiChanged,
    onBackfillCompile: (taskId, rawPath) => feed.trackTask(taskId, rawPath),
  })
  // ── P3 票02：素材包剔除/焦点重编译覆盖层 ──
  const packs = useKcPacks({ pollMs: feedPollMs, onSettled: onWikiChanged })
  // ── P3 票03：判例退役覆盖层（红线2 唯一写通道） ──
  const cases = useKcCases({ pollMs: feedPollMs, onSettled: onWikiChanged })
  // ── P3 票05：skill 授予覆盖层（同步机械链 REST） ──
  const grants = useKcGrants()
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = activeId

  // 会话切换 ⇒ 载侧挂沉淀（首拍 persist 跳过竞态同票12 注）。
  const skipNextPersistRef = useRef(false)
  useEffect(() => {
    restore(loadPersistedCards(activeId))
    skipNextPersistRef.current = true
    citedInitRef.current = false // 新会话首见卡不补药丸
  }, [activeId, restore])
  useEffect(() => {
    if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return }
    persistCards(activeId, feed.cards)
  }, [activeId, feed.cards])

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
    if (e.kind === 'material-pack') {
      const d = e.data as KcMaterialPackCardData
      const rc = packs.recompileStates[d.taskId]
      if (!rc) return e
      return { ...e, data: { ...d, recompile: rc } }
    }
    if (e.kind === 'case') {
      const d = e.data as KcCaseCardData
      const rt = cases.retireStates[d.caseId]
      if (!rt) return e
      return { ...e, data: { ...d, retire: rt } }
    }
    if (e.kind === 'skill-draft') {
      const d = e.data as KcSkillDraftCardData
      const g = grants.states[d.draftName]
      if (!g) return e
      return { ...e, data: { ...d, grant: g } }
    }
    return e
  }, [feed.revertStates, findings.fixStates, findings.backfillStates, findings.findingStatus, packs.recompileStates, cases.retireStates, grants.states])

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

  // ── 引用药丸（替代已废除的「跟随」）：新卡首见 ⇒ 上抛 onCite，正文永不动 ──
  const citedInitRef = useRef(false)
  const citedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const all = [...laneAByMsgId.values()].flat().concat(tailEvents).sort((a, b) => a.ts.localeCompare(b.ts))
    if (!citedInitRef.current) {
      all.forEach(e => citedRef.current.add(e.id))
      citedInitRef.current = true
      return
    }
    for (const e of all) {
      if (citedRef.current.has(e.id)) continue
      citedRef.current.add(e.id)
      const refs = kcEventPageRefs(e)
      const hit = refs.map(r => resolveKcPageTarget(tree, r)).find(Boolean)
      if (hit) onCite(hit, e.id)
    }
  }, [laneAByMsgId, tailEvents, tree, onCite])

  // ── 卡动作上下文（原 openFullPage 语义随双模式废除并入 openPage：ADR-0033） ──
  const ctx: KcCardActionCtx = useMemo(() => ({
    openPage: target => { const id = resolveKcPageTarget(tree, target); if (id) onOpenPage(id) },
    openRaw: pointerPath => onOpenRaw(pointerPath),
    revert: commit => void feed.revert(commit),
    retryCompile: (cardId, rawPath) => void feed.retryCompile(cardId, rawPath),
    sayToCurator: text => setComposerSeed(text),
    adoptFinding: fid => void findings.adopt(fid),
    ignoreFinding: fid => void findings.ignore(fid),
    backfillWiki: (cardId, input) => void findings.backfill(cardId, {
      ...input,
      sessionId: input.sessionId ?? sessionIdRef.current ?? undefined,
    }),
    dismissBackfill: cardId => findings.dismissBackfill(cardId),
    recompilePack: (taskId, input) => void packs.recompile(taskId, input),
    retireCase: caseId => void cases.retire(caseId),
    retirePage: pagePath => void feed.retire(pagePath),
    grantDraft: (draftName, cloneName) => void grants.grant(draftName, cloneName),
    revokeDraft: (draftName, cloneName) => void grants.revoke(draftName, cloneName),
    grantTargets: grants.targets,
    grantTargetsError: grants.targetsError,
  }), [tree, onOpenPage, onOpenRaw, feed.revert, feed.retryCompile, feed.retire, findings.adopt, findings.ignore, findings.backfill, findings.dismissBackfill, packs.recompile, cases.retire, grants.grant, grants.revoke, grants.targets, grants.targetsError])

  // ── 发送：投喂/退役/恢复/体检意图走执行面；对话面原文照常发策展人（不劫持布局） ──
  const handleSend = useCallback((message: string) => {
    const intent = classifyKcFeed(message)
    if (intent) void feed.feed(intent)
    if (!intent && /体检|巡检/.test(message)) void findings.patrol()
    const retire = classifyKcRetire(message)
    if (retire) void feed.retire(retire.path)
    const restoreIntent = classifyKcRestore(message)
    if (restoreIntent) void feed.restorePage(restoreIntent)
    if (intent?.mode === 'text') {
      chat.sendMessage(`刚投喂了一段文本素材（${intent.text.length} 字），已落 raw 待编译——请知悉并纳入下轮巡检。`)
    } else {
      chat.sendMessage(message)
    }
  }, [chat.sendMessage, feed.feed, feed.retire, feed.restorePage, findings.patrol])

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

  const activeTab = tabs.find(t => t.id === activeId)

  return (
    <div
      data-testid="kc-curator-drawer"
      className={cn(
        'fixed inset-y-0 right-0 z-50 flex flex-col border-l-[1.5px] border-pop-bd bg-pop-idle shadow-[var(--pop-shadow-lg)] transition-transform duration-200',
        open ? 'translate-x-0' : 'translate-x-[102%]',
      )}
      style={{ width: Math.min(width, Math.round(typeof window !== 'undefined' ? window.innerWidth * 0.94 : width)) }}
    >
      {/* 拖宽把手（左缘） */}
      <div
        data-testid="kc-drawer-resize"
        title="拖动调宽"
        onMouseDown={e => { dragRef.current = { x: e.clientX, w: width }; e.preventDefault() }}
        className="absolute inset-y-0 -left-1 z-10 w-[7px] cursor-ew-resize hover:bg-pop-pink/40"
      />
      {/* 抽屉头 */}
      <div className="flex shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-bg px-3 py-1.5 text-[11px] font-bold text-pop-dim">
        <span className="text-pop-green">●</span>
        <span className="text-pop-ink">策展人 · archive</span>
        <button
          type="button"
          data-testid="kc-drawer-history"
          onClick={() => { void refreshSessions(); setHistoryOpen(v => !v) }}
          className="rounded border-[1.5px] border-pop-bd px-2 py-0.5 hover:bg-accent hover:text-pop-ink"
        >
          🗂 历史 {history.length}
        </button>
        <button
          type="button"
          data-testid="kc-drawer-close"
          onClick={onClose}
          className="ml-auto rounded px-2 py-0.5 text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          ✕
        </button>
      </div>
      {/* 会话 tab 条 */}
      <div data-testid="kc-drawer-tabs" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b-[1.5px] border-pop-bd bg-pop-bg px-2 py-1.5">
        {tabs.map(t => (
          <span
            key={t.id}
            className={cn(
              'flex items-center gap-1 rounded-lg border-[1.5px] px-2 py-0.5 text-[11px] font-bold',
              t.id === activeId ? 'border-pop-pink bg-pop-pink-soft text-pop-pink' : 'border-pop-bd text-pop-dim hover:text-pop-ink',
            )}
          >
            <button type="button" data-testid={`kc-drawer-tab-${t.id}`} onClick={() => setActiveId(t.id)} className="max-w-[160px] truncate">
              {t.title}
            </button>
            {tabs.length > 1 && (
              <button
                type="button"
                aria-label={`关闭会话 ${t.title}`}
                onClick={() => handleCloseTab(t.id)}
                className="text-pop-dim hover:text-pop-red"
              >
                ✕
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          data-testid="kc-new-session"
          onClick={() => void handleNewSession()}
          className="rounded-lg border-[1.5px] border-dashed border-pop-bd px-2 py-0.5 text-[11px] font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          ＋ 新会话
        </button>
      </div>
      {historyOpen && (
        <div data-testid="kc-drawer-history-pop" className="absolute right-2 top-[88px] z-20 w-[320px] rounded-xl border-[1.5px] border-pop-bd bg-pop-paper p-1.5 shadow-[var(--pop-shadow-lg)]">
          <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">知识中心会话 · 点开重新打开</div>
          {history.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => openTab(s.id, s.title)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-bold text-pop-ink hover:bg-accent"
            >
              <span className="truncate flex-1">{s.title}</span>
              <span className="shrink-0 text-[10px] font-normal text-pop-dim">{(s.last_message_at ?? s.updated_at).slice(5, 16).replace('T', ' ')}</span>
            </button>
          ))}
          {history.length === 0 && <div className="px-2 py-1.5 text-[11px] text-pop-dim">没有已收起的会话</div>}
        </div>
      )}
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
        hasSession={!!activeId}
        currentCloneName={ARCHIVE_CLONE}
        emptyStateTitle="对话即管理"
        emptyStateDescription="投喂 raw（URL/粘贴/路径）、问问题、改页、回滚——管理就是说话。卡片协议沉淀每次操作。"
        composerPlaceholder={activeTab ? `在「${activeTab.title}」问 · 投喂 · 改页…` : '投喂 raw（URL/粘贴/路径）· 问问题 · 「体检一下」…'}
        composerSeed={composerSeed}
        messageExtras={extras}
        transcriptTail={tail}
        contextUsage={chat.contextUsage}
        sessionUsage={null}
      />
    </div>
  )
}
