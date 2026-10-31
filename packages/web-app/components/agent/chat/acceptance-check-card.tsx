"use client"

// 聊天里的「验收项卡」（2026-10-30 · 用户定稿：卡片必须信息完整）
//
// 为什么不是一行字 + 三个按钮：验收人要点的是「这一项到底怎么验、证据在哪、
// 机器怎么说」。所以卡片自带：第 x/N、通过标准、怎么验（命令/步骤）、机器建议、
// 证据摘要，外加三个判定按钮与「打开验收台」。
//
// 交互纪律：
//   · 点按钮 = 快捷方式；直接在对话里说「通过 / 不行，因为…」同样算数，
//     由 Agent 调 record_acceptance_check 记录（随后卡片会被标成已选）。
//   · 选过就只读（与服务端 activity.decision 同步），历史里不会一直可点。

import type { AgentMessage } from '@/lib/agent/types'

interface AcceptanceHowTo {
  kind: 'run' | 'open' | 'check'
  text: string
  command?: string
  path?: string
}
interface AcceptanceStep {
  kind: 'open' | 'do' | 'observe'
  text: string
  target?: string
  value?: string
  expect?: string
}
interface AcceptanceMachine {
  verdict: 'pass' | 'warn' | 'human'
  why: string
  command?: string
}
interface AcceptanceEvidence {
  kind: string
  label: string
  missing?: boolean
}
interface AcceptancePayload {
  acceptanceCheck?: boolean
  itemId?: string
  title?: string
  ticket?: string
  tickets?: string[]
  story?: string
  setup?: string
  index?: number
  total?: number
  expect?: string
  steps?: AcceptanceStep[]
  howTo?: AcceptanceHowTo[]
  machine?: AcceptanceMachine
  evidence?: AcceptanceEvidence[]
}

const STEP_LABEL: Record<string, string> = { open: '打开', do: '操作', observe: '看' }

const VERDICT: Record<string, { label: string; cls: string }> = {
  pass: { label: '机器建议通过', cls: 'text-pop-green border-pop-green/40 bg-pop-green/[0.08]' },
  warn: { label: '机器建议留意', cls: 'text-pop-amber border-pop-amber/40 bg-pop-amber/[0.08]' },
  human: { label: '需你判断', cls: 'text-pop-cyan border-pop-cyan/35 bg-pop-cyan/[0.05]' },
}

const KIND_ICON: Record<string, string> = { diff: '±', test: '▷', report: '¶', preview: '▶', docs: '•' }

export function AcceptanceCheckCard({
  message,
  fireAction,
}: {
  message: AgentMessage
  fireAction: (actionId: string) => void
}) {
  const activity = message.activity
  const p = (activity?.payload ?? {}) as AcceptancePayload
  const decision = activity?.decision ?? null
  const decided = !!decision
  const actions = Array.isArray(activity?.actions) ? activity!.actions! : []
  const m = p.machine ? VERDICT[p.machine.verdict] ?? VERDICT.human : null
  const steps = (p.steps ?? []).slice(0, 8)
  const howTo = (p.howTo ?? []).slice(0, 3)
  const evidence = (p.evidence ?? []).slice(0, 4)
  const isScenario = steps.length > 0

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="acceptance-check-card"
      data-decision={decided ? 'set' : 'open'}
      className={[
        'rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed',
        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
        decided
          ? 'border-pop-bd/70 bg-white/[0.015] text-pop-dim'
          : 'border-pop-cyan/35 bg-pop-cyan/[0.04]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className={`grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px] ${decided ? 'text-pop-dim' : 'text-pop-cyan'}`}>
          {decided ? '✓' : '?'}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-pop-ink/85">
          {isScenario ? '验收场景' : '验收项'} {p.index != null && p.total != null ? `${p.index}/${p.total}` : ''} · {p.title ?? activity?.title ?? '验收项'}
        </span>
        {(p.tickets?.length || p.ticket) && (
          <span className="shrink-0 rounded border border-pop-bd/70 px-1.5 py-[1px] text-[9px] text-pop-dim">
            {(p.tickets?.length ? p.tickets.join(' · ') : p.ticket)}
          </span>
        )}
        {decided && (
          <span className="shrink-0 text-[9px] text-pop-dim/70" data-testid="acceptance-card-decision">
            已选 · {decision?.label ?? decision?.id}
            {decision?.at ? ` ${new Date(decision.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        )}
      </div>

      {isScenario && (p.story || p.setup) && (
        <div className="mt-1.5 space-y-0.5 pl-6">
          {p.story && <div className="text-[10.5px] text-pop-ink/70">{p.story}</div>}
          {p.setup && <div className="text-[9.5px] text-pop-dim">起点：{p.setup}</div>}
        </div>
      )}

      {p.expect && (
        <div className="mt-1.5 pl-6">
          <div className="text-[9px] font-black tracking-wide text-pop-dim/80">通过标准</div>
          <div className="mt-0.5 text-[10.5px] text-pop-ink/75">{p.expect}</div>
        </div>
      )}

      {steps.length > 0 && (
        <div className="mt-1.5 pl-6">
          <div className="text-[9px] font-black tracking-wide text-pop-dim/80">怎么验</div>
          <ol className="mt-0.5 space-y-0.5">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[10.5px] text-pop-ink/70">
                <span className="mt-[1px] shrink-0 text-[9px] text-pop-dim">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="mr-1 rounded border border-pop-bd/60 px-1 text-[8.5px] text-pop-dim">{STEP_LABEL[s.kind] ?? s.kind}</span>
                  {s.text}
                  {(s.value || s.target) && (
                    <code className="ml-1 break-all rounded bg-black/25 px-1 text-[9.5px] text-pop-cyan/80" title={s.value ?? s.target}>
                      {(s.value ?? s.target)!.length > 60 ? `${(s.value ?? s.target)!.slice(0, 60)}…` : (s.value ?? s.target)}
                    </code>
                  )}
                  {s.expect && <span className="ml-1 text-[9px] text-pop-dim">（预期：{s.expect}）</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {steps.length === 0 && howTo.length > 0 && (
        <div className="mt-1.5 pl-6">
          <div className="text-[9px] font-black tracking-wide text-pop-dim/80">怎么验</div>
          <ol className="mt-0.5 space-y-0.5">
            {howTo.map((h, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[10.5px] text-pop-ink/70">
                <span className="mt-[1px] shrink-0 text-[9px] text-pop-dim">{i + 1}.</span>
                <span className="min-w-0">
                  {h.text}
                  {(h.command || h.path) && (
                    <code className="ml-1 break-all rounded bg-black/25 px-1 text-[9.5px] text-pop-cyan/80" title={h.command ?? h.path}>
                      {(h.command ?? h.path)!.length > 90 ? `${(h.command ?? h.path)!.slice(0, 90)}…` : (h.command ?? h.path)}
                    </code>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(m || evidence.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
          {m && (
            <span className={`rounded-full border px-1.5 py-[1px] text-[9px] font-bold ${m.cls}`} title={p.machine?.why}>
              {m.label}
            </span>
          )}
          {evidence.map((e, i) => (
            <span
              key={i}
              title={e.label}
              className={`rounded border px-1.5 py-[1px] text-[9px] ${e.missing ? 'border-pop-red/40 text-pop-red' : 'border-pop-bd/70 text-pop-dim'}`}
            >
              {KIND_ICON[e.kind] ?? '•'} {e.label}{e.missing ? ' · 缺证据' : ''}
            </span>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 pl-6" data-testid="task-card-actions">
          {actions.map((action) => {
            const chosen = decision?.id === action.id
            return (
              <button
                key={action.id}
                type="button"
                disabled={decided && action.id !== 'acceptance_open_window'}
                onClick={() => fireAction(action.id)}
                className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-default ${
                  chosen
                    ? 'border-pop-green/50 bg-pop-green/10 font-bold text-pop-green'
                    : 'border-current/30 bg-black/10 text-pop-ink hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-black/10'
                }`}
              >
                {chosen ? '✓ ' : ''}{action.label}
              </button>
            )
          })}
          {!decided && (
            <span className="ml-1 text-[9px] text-pop-dim/70">也可以直接说「通过 / 不行，因为…」</span>
          )}
        </div>
      )}
    </div>
  )
}
