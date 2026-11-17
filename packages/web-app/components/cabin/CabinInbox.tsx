'use client'

// classic 编队 v6 · inbox（2026-11-17 用户口径）：
//   编队只放「作战」实体（任务 / 工作流 / 分身作业），点开是只读详情；
//   「要我处理」单独一个悬浮，挂在编队上方：
//     · 常驻 chip：「要我处理 N」+ 待你定 / 待验收 / 受阻 三色计数；
//     · 点开在**图标左边**出一列待办（带分组计数）；
//     · 选一条才打开对应入口：待你定 → 问答窗（无票据时回任务线程），
//       待验收 → 任务验收视图，受阻 / 裁决 → 对应任务 / 记录。
// 数据仍是 CabinProvider.view.attention（唯一事实源）+ 问答窗 Provider 的
// 乐观已答集合；这里不新造状态，也不重排 attention。
// 2026-11-17 用户口径：待放行不再跳任务线程 —— 点行直接开**放行窗**（汐音总结 +
// 选项 + 当场 ready/trigger/resume），执行成功即乐观消项。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Inbox as InboxIcon } from 'lucide-react'
import type { CabinAttentionItem } from '@octopus/shared'
import { cn } from '@/lib/utils'
import { useCabinContext } from './cabin-provider'
import { useAskWindows } from './asks/ask-windows-provider'
import { askWindowTitle } from './asks/ask-window-model'
import { StartWindow, startDecisionKey } from './asks/start-window'
import { openTaskInChat } from './modules/ui'

type InboxType = 'ask' | 'start' | 'review' | 'blocked'

interface InboxItem {
  key: string
  type: InboxType
  /** 行标题：任务 / 找上来的事。 */
  name: string
  /** 第二行：要你定 / 验收 / 处理的具体内容。 */
  question: string
  /** 原始 attention 项（非票据提问用它路由）。 */
  attn?: CabinAttentionItem
  /** 有决策票据的问答窗 id。 */
  askId?: string
}

const TYPE_LABEL: Record<InboxType, string> = {
  ask: '待你定',
  start: '待放行',
  review: '待验收',
  blocked: '受阻',
}
/** 三组只变计数口径：start（待入列/触发/恢复）归「待你定」——都是人给一脚。 */
const GROUPS: Array<{ key: string; label: string; types: InboxType[] }> = [
  { key: 'decide', label: '待你定', types: ['ask', 'start'] },
  { key: 'review', label: '待验收', types: ['review'] },
  { key: 'blocked', label: '受阻', types: ['blocked'] },
]

/** attention 标题去掉服务端后缀（`· 待验收` / `· 委派失败`），只留主体名。 */
function attentionName(item: CabinAttentionItem): string {
  return item.title
    .replace(/\s*·\s*待(验收|归档|审批|回答|入列|触发|恢复)$/, '')
    .replace(/\s*·\s*(失败已升级|委派失败|委派在问你)$/, '')
    || item.title
}

/** 提问行标题：去掉 `· 待回答`，再去掉主线程标记；列表宽度有限，主体名优先。 */
function askName(item: CabinAttentionItem): string {
  return askWindowTitle(item)
    .replace(/\s*·\s*任务主线程$/, '')
    .replace(/\s*·\s*(委派在问你|失败已升级|委派失败)$/, '')
    || askWindowTitle(item)
}

export function CabinInbox() {
  const { cabin, view, refresh, openModule, openJobDetail } = useCabinContext()
  const { asks, open: openAsk } = useAskWindows()
  const [open, setOpen] = useState(false)
  /** 打开中的放行窗（快照 attention 项，刷新不腾空窗内选项）。 */
  const [startItem, setStartItem] = useState<CabinAttentionItem | null>(null)
  /** 已执行成功的 start 项：服务端 view 刷新前先把它从列表里拿掉。 */
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set())
  const rootRef = useRef<HTMLElement>(null)

  // view 里已经消失的乐观项要清掉：否则同一个 id 以后再出现会被永久藏住。
  useEffect(() => {
    setDecided((prev) => {
      if (prev.size === 0) return prev
      const live = new Set(
        (view?.attention ?? [])
          .filter((item) => item.stage === 'start')
          .map((item) => startDecisionKey(item)),
      )
      const next = new Set([...prev].filter((key) => live.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [view?.attention])

  const items = useMemo<InboxItem[]>(() => {
    const out: InboxItem[] = []
    const ticketed = new Set<string>()
    for (const ask of asks) {
      const { item, env } = ask
      ticketed.add(item.id)
      out.push({
        key: `ask-${ask.askId}`,
        type: 'ask',
        name: askName(item),
        question: env.decision || item.question || '在问你',
        attn: item,
        askId: ask.askId,
      })
    }
    for (const item of view?.attention ?? []) {
      if (!item || item.awaiting !== 'person') continue
      if (item.stage === 'start' && decided.has(startDecisionKey(item))) continue
      // 有票据的提问由上面的乐观集合负责（已答后不在这里复活）。
      if (item.ask?.ask_id || ticketed.has(item.id)) continue
      const question = item.question || item.detail || ''
      if (item.stage === 'answer' || item.stage === 'adjudicate') {
        out.push({ key: item.id, type: 'ask', name: attentionName(item), question, attn: item })
      } else if (item.stage === 'start') {
        out.push({ key: item.id, type: 'start', name: attentionName(item), question, attn: item })
      } else if (item.stage === 'review' || item.stage === 'approval') {
        out.push({ key: item.id, type: 'review', name: attentionName(item), question, attn: item })
      } else if (item.stage === 'blocked') {
        out.push({ key: item.id, type: 'blocked', name: attentionName(item), question, attn: item })
      }
    }
    return out
  }, [asks, decided, view?.attention])

  const counts = useMemo(() => ({
    ask: items.filter((i) => i.type === 'ask' || i.type === 'start').length,
    review: items.filter((i) => i.type === 'review').length,
    blocked: items.filter((i) => i.type === 'blocked').length,
    total: items.length,
  }), [items])

  const route = useCallback((item: InboxItem) => {
    setOpen(false)
    if (item.askId) { openAsk(item.askId); return }
    const attn = item.attn
    if (!attn) return
    // 待放行：不跳任务线程，直接在浮窗里放行（2026-11-17 用户口径）。
    if (attn.stage === 'start') { setStartItem(attn); return }
    if (attn.deep_link?.startsWith('finding:')) { openModule('records'); return }
    if (attn.task_id) {
      openTaskInChat(attn.task_id, attn.stage === 'review' ? 'acceptance' : undefined)
      return
    }
    if (attn.job_id) { openJobDetail(attn.job_id); return }
    openModule('queue')
  }, [openAsk, openModule, openJobDetail])

  const handleStartDecided = useCallback((decisionKey: string) => {
    setDecided((prev) => {
      if (prev.has(decisionKey)) return prev
      const next = new Set(prev)
      next.add(decisionKey)
      return next
    })
    void refresh()
  }, [refresh])

  // 点空白 / Esc 收起左侧列表；ask 窗与其它浮窗的 Esc 各自处理。
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!cabin) return null

  const zero = counts.total === 0

  return (
    <>
      <aside className="ck-inbox" data-testid="cabin-inbox" aria-label="要我处理" ref={rootRef}>
      <button
        type="button"
        className="ck-inbox-chip"
        data-testid="cabin-inbox-chip"
        data-open={open ? 'true' : undefined}
        data-zero={zero ? 'true' : undefined}
        aria-expanded={open}
        aria-label={zero ? '要我处理 · 暂无待办' : `要我处理 ${counts.total} 条`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ic"><InboxIcon className="size-[13px]" strokeWidth={1.8} /></span>
        <span className="mid">
          <span className="t">要我处理 {!zero && <i className="dot" />}</span>
          <span className="brk">
            {zero ? (
              <span className="bq none">暂无待办</span>
            ) : (
              <>
                <span className={cn('bq ask', !counts.ask && 'off')}><i />待你定 {counts.ask}</span>
                <span className={cn('bq review', !counts.review && 'off')}><i />验收 {counts.review}</span>
                <span className={cn('bq blocked', !counts.blocked && 'off')}><i />受阻 {counts.blocked}</span>
              </>
            )}
          </span>
        </span>
        <span className="n">{counts.total}</span>
      </button>

      {open && (
        <div className="ck-inboxpop" data-testid="cabin-inbox-pop">
          <div className="ck-inboxpop-h">
            <span className="t">要我处理</span><b>{counts.total}</b>
            <span className="brk">
              待你定 {counts.ask} · 待验收 {counts.review} · 受阻 {counts.blocked}
            </span>
          </div>
          <div className="ck-inboxpop-body">
            {zero ? (
              <div className="ck-inboxpop-empty" data-testid="cabin-inbox-empty"><b>✓</b>都处理完了</div>
            ) : GROUPS.map((group) => {
              const rows = items.filter((i) => group.types.includes(i.type))
              if (rows.length === 0) return null
              return (
                <div key={group.key}>
                  <div className="ck-inboxpop-group" data-type={group.key}>
                    <span>{group.label}</span><b>{rows.length}</b>
                  </div>
                  {rows.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="ck-inboxpop-row"
                      data-testid={`cabin-inbox-row-${item.key}`}
                      onClick={() => route(item)}
                    >
                      <span className="r1">
                        <span className="ck-inboxpop-type" data-type={item.type}>{TYPE_LABEL[item.type]}</span>
                        <span className="ck-inboxpop-name">{item.name}</span>
                        <span className="ck-inboxpop-go">
                          {item.type === 'start' ? '放行 →' : item.askId ? '回答 →' : '去处理 →'}
                        </span>
                      </span>
                      <span className="ck-inboxpop-q">{item.question || '（打开看详情）'}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          {!zero && <div className="ck-inboxpop-foot">Esc 收起 · 待放行可直接在浮窗处理</div>}
        </div>
      )}
      </aside>
      {startItem && (
        <StartWindow
          key={startItem.id}
          item={startItem}
          onClose={() => setStartItem(null)}
          onDecided={handleStartDecided}
        />
      )}
    </>
  )
}
