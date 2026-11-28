'use client'

// 会话详情面（2026-11-25 用户；原型 docs/cabin-design/cockpit-v22.html 的 chat 会话面）。
//
// 会话 = cabin_delegations（汐音委派与人自开同一本账，origin 区分创建者）。
// 它没有任务口径的变更 / 验收 / 归档 / 项目 —— 基础页签固定六项：
//   · 对接   —— 任务书（意图 / brief / 托管）+ 结论（执行者 → 汐音 → 你）；
//               人自开的会话没有任务书，只有第一条原话；
//   · 文件   —— 本舱 cwd 只读目录树（会话没有专属 worktree，文件就是舱里的文件）；
//   · 运行   —— 会话状态 + 回合读数（调试轮次：模型 / 状态 / 时长 / token）；
//   · 调试   —— per-turn SDK inspector（与作业面同一份）；
//   · 消耗   —— 本会话账本（主回合按轮 + 子代理单列，防双算）；
//   · 子代理 —— 本会话派出的子代理 / 后台作业（运行中置顶，已结束留档）。
// 默认落「对接」（select() 在 CockpitStateProvider 里兜底）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cabinRawUrl, getCabinFile, type CabinDelegationView } from '@/lib/cabin-api'
import { listSessionDebugTurns } from '@/lib/agent/debug-api'
import type { TurnDebugSummary } from '@/lib/agent/debug-types'
import { formatDuration, formatTokenCount } from '@/lib/format'
import { useTreeScan } from './use-tree-scan'
import { ancestorsOf, buildTree, TreeRows } from './CockpitJobFiles'
import { CockpitJobDebug } from './CockpitJobDebug'
import { CockpitJobUsage } from './CockpitJobUsage'
import { CockpitJobAgents, useSessionActivity } from './CockpitJobAgents'
import {
  CockpitElapsed, CockpitJobHeader, CockpitJobTabs,
} from './CockpitJobHeader'
import { COCKPIT_SESSION_TABS, type CockpitTab } from '../state/cockpit-state'
import { delegationStatusLabel } from '../fleet/fleet-model'

const POLL_MS = 10_000
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])

function extOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null
}

/** 委派 brief（后端 JSON 里是 unknown；这里只读、不猜字段）。 */
interface SessionBrief {
  goal: string | null
  doneWhen: string[]
  constraints: string[]
  autonomy: string | null
}

function briefOf(value: unknown): SessionBrief | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const text = (key: string) => (typeof record[key] === 'string' && record[key].trim() ? record[key] as string : null)
  const list = (key: string) => (Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [])
  const brief: SessionBrief = {
    goal: text('goal'),
    doneWhen: list('done_when'),
    constraints: list('constraints'),
    autonomy: text('autonomy'),
  }
  return brief.goal || brief.doneWhen.length > 0 || brief.constraints.length > 0 || brief.autonomy ? brief : null
}

/** 委派状态 → 作业状态词（头部 emoji / 状态色沿用 jobTone 一套，不另造）。 */
function asJobStatus(state: CabinDelegationView['state'] | null | undefined): string | null {
  if (!state) return null
  if (state === 'queued') return 'pending'
  if (state === 'waiting_input') return 'pending_interaction'
  return state
}

/** 归档后的会话沿用 done 的色调（头部 emoji / 状态色），状态词靠 kv 表达。 */
function headStatusOf(delegation: CabinDelegationView): string | null {
  return delegation.archived_at ? 'done' : asJobStatus(delegation.state)
}

function turnStatusLabel(status: TurnDebugSummary['status']): string {
  if (status === 'ok') return '完成'
  if (status === 'running') return '运行中'
  if (status === 'interrupted') return '中断'
  if (status === 'error') return '异常'
  return status
}

function useSessionTurns(sessionId: string | null): { turns: TurnDebugSummary[]; error: string | null } {
  const [turns, setTurns] = useState<TurnDebugSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setTurns([])
    setError(null)
    if (!sessionId) return
    let alive = true
    const load = () => {
      listSessionDebugTurns(sessionId).then(
        (res) => { if (alive) { setTurns(res.turns ?? []); setError(null) } },
        (err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : '读取会话回合失败')
        },
      )
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [sessionId])
  return { turns, error }
}

export interface CockpitSessionFaceProps {
  cabinId: string
  /** 编队行里的会话实体；null = 还没接上（先画载入头）。 */
  delegation?: CabinDelegationView | null
  cabinName?: string | null
  tab: CockpitTab
  onTabChange(tab: CockpitTab): void
  onClose: () => void
  /** v22 #5：打开这条会话的独立 chat 窗（有 doer 会话才传）。 */
  onOpenChat?: (() => void) | null
}

export function CockpitSessionFace({
  cabinId,
  delegation = null,
  cabinName,
  tab,
  onTabChange,
  onClose,
  onOpenChat,
}: CockpitSessionFaceProps) {
  const sessionId = delegation?.doer_session_id ?? null
  const agentsActivity = useSessionActivity(sessionId)
  const { turns, error: turnsError } = useSessionTurns(sessionId)
  // 会话没有「运行 / 变更 / 验收 / 归档 / 项目」——落到这五签时兜回「对接」。
  const activeTab: CockpitTab = COCKPIT_SESSION_TABS.includes(tab) ? tab : 'relay'

  if (!delegation) {
    return (
      <>
        <CockpitJobHeader loading onClose={onClose} />
        <div className="ck12-face-body">
          <div className="ck12-face-empty">载入会话…</div>
        </div>
      </>
    )
  }

  const brief = briefOf(delegation.brief)
  const title = delegation.title
  const createdAt = delegation.created_at
  const endedAt = delegation.ended_at
  const status = headStatusOf(delegation)
  const statusText = delegationStatusLabel(delegation)
  const sessionShort = shortId(sessionId)
  const subtitle = [cabinName, sessionShort ? `会话 ${sessionShort}` : null].filter(Boolean).join(' · ')

  const panes = (
    <>
      {activeTab === 'relay' && (
        <div data-testid="cockpit-session-relay" className="ck12-tab">
          <div className="ck12-pnote">
            {delegation.origin === 'user'
              ? '这条会话是你自己开的 —— 与汐音委派同一本账；第一条原话在这里留档，过程在独立 chat 窗里。'
              : '会话对接 = 派给它的任务书 + 它交回的结论；执行者的过程回报先到汐音，这里只留关键三跳。'}
          </div>

          <div className="ck12-kv">
            <div className="ck12-kvi">
              <div className="k">状态</div>
              <div className="v is-a">{statusText}</div>
            </div>
            <div className="ck12-kvi">
              <div className="k">会话</div>
              <div className="v">{sessionShort ?? '—'}</div>
            </div>
            {delegation.handle && (
              <div className="ck12-kvi">
                <div className="k">句柄</div>
                <div className="v">{delegation.handle}</div>
              </div>
            )}
            {delegation.autonomy && (
              <div className="ck12-kvi">
                <div className="k">托管</div>
                <div className="v">{delegation.autonomy}</div>
              </div>
            )}
            <div className="ck12-kvi">
              <div className="k">用时</div>
              <div className="v"><CockpitElapsed start={delegation.created_at} end={delegation.ended_at} /></div>
            </div>
          </div>

          {delegation.intent_text && (
            <div className="ck12-jmandate" data-testid="cockpit-session-intent">
              <div className="h">
                <b>派发原文</b>
                <span className="k">你 → 汐音</span>
              </div>
              <p>{delegation.intent_text}</p>
            </div>
          )}

          {brief && (
            <div className="ck12-jmandate" data-testid="cockpit-session-brief">
              <div className="h">
                <b>任务书</b>
                {brief.autonomy && <span className="k">托管 {brief.autonomy}</span>}
              </div>
              {brief.goal && <p>{brief.goal}</p>}
              {brief.doneWhen.length > 0 && (
                <ul className="ck12-jac">
                  {brief.doneWhen.map((item, index) => (
                    <li key={`done-${index}`}><span aria-hidden="true">◇</span>{item}</li>
                  ))}
                </ul>
              )}
              {brief.constraints.length > 0 && (
                <ul className="ck12-jac">
                  {brief.constraints.map((item, index) => (
                    <li key={`limit-${index}`}><span aria-hidden="true">⊘</span>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {delegation.result_summary && (
            <div className="ck12-jmandate" data-testid="cockpit-session-result">
              <div className="h">
                <b>结论</b>
                <span className="k">执行者 → 汐音 → 你</span>
              </div>
              <p>{delegation.result_summary}</p>
            </div>
          )}

          <div className="ck12-face-actions">
            {onOpenChat && (
              <button
                type="button"
                className="ck12-jh-go"
                data-testid="cockpit-session-chat"
                onClick={onOpenChat}
              >
                去会话对话 →
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === 'files' && (
        <div data-testid="cockpit-session-files" className="ck12-tab">
          <CockpitSessionFiles cabinId={cabinId} />
        </div>
      )}

      {activeTab === 'run' && (
        <div data-testid="cockpit-session-run" className="ck12-tab">
          <div className="ck12-kv">
            <div className="ck12-kvi">
              <div className="k">状态</div>
              <div className="v is-a">{statusText}</div>
            </div>
            <div className="ck12-kvi">
              <div className="k">回合</div>
              <div className="v">{turns.length}</div>
            </div>
            <div className="ck12-kvi">
              <div className="k">用时</div>
              <div className="v"><CockpitElapsed start={createdAt} end={endedAt} /></div>
            </div>
          </div>

          {turnsError && <div className="ck12-face-empty">{turnsError}</div>}
          {!sessionId && <div className="ck12-face-empty">这段会话还没有绑定会话 · 跑起来后这里给回合读数。</div>}
          {sessionId && turns.length === 0 && !turnsError && (
            <div className="ck12-face-empty">这一段还没有回合 · 人说第一句后这里开始计数。</div>
          )}

          {turns.length > 0 && (() => {
            const latest = [...turns].sort((a, b) => b.turn_index - a.turn_index)[0]
            const recent = [...turns].sort((a, b) => b.turn_index - a.turn_index).slice(0, 6)
            return (
              <>
                <div className="ck12-jmandate">
                  <div className="h">
                    <b>本轮</b>
                    <span className="k">T{latest.turn_index}</span>
                    <span>{turnStatusLabel(latest.status)}</span>
                  </div>
                  <p>
                    {[
                      latest.model ?? '模型未知',
                      latest.duration_ms != null ? formatDuration(latest.duration_ms) : null,
                      latest.usage ? `${formatTokenCount(latest.usage.totalTokens)} tok` : null,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="ck12-sect">最近回合</div>
                {recent.map((turn) => (
                  <div className="ck12-umrow" key={turn.id}>
                    <span className="mn">T{turn.turn_index}</span>
                    <span className="md">{turn.model ?? '模型未知'} · {turnStatusLabel(turn.status)}</span>
                    <span className="mv">{formatTokenCount(turn.usage?.totalTokens ?? 0)}</span>
                    <span className="mc">{turn.duration_ms != null ? formatDuration(turn.duration_ms) : '—'}</span>
                  </div>
                ))}
              </>
            )
          })()}
        </div>
      )}

      {activeTab === 'debug' && (
        <div data-testid="cockpit-session-debug" className="ck12-tab">
          <CockpitJobDebug sessionId={sessionId} />
        </div>
      )}

      {activeTab === 'usage' && (
        <div data-testid="cockpit-session-usage" className="ck12-tab">
          <CockpitJobUsage sessionId={sessionId} what="会话" />
        </div>
      )}

      {activeTab === 'agents' && (
        <div data-testid="cockpit-session-agents" className="ck12-tab">
          <CockpitJobAgents sessionId={sessionId} activity={agentsActivity} what="会话" />
        </div>
      )}
    </>
  )

  return (
    <>
      <CockpitJobHeader
        title={title}
        status={status}
        onClose={onClose}
        subtitle={subtitle}
        startedAt={createdAt}
        endedAt={endedAt}
        onOpenChat={onOpenChat ?? null}
      />
      <div className="ck12-face-body" data-testid="cockpit-face-session">
        <CockpitJobTabs
          tab={activeTab}
          onTabChange={onTabChange}
          tabs={COCKPIT_SESSION_TABS}
          badges={agentsActivity.total > 0 ? { agents: agentsActivity.total } : undefined}
        />
        {panes}
      </div>
    </>
  )
}

/** 会话文件：本舱 cwd 只读目录树（会话没有专属 worktree）。 */
function CockpitSessionFiles({ cabinId }: { cabinId: string }) {
  const scan = useTreeScan({ cabinId, repoName: null })
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // 展开 / 选中只在「换根 / 首次载入」重置；30s 静默刷新只换 entries（与目录窗同口径）。
  const initGenRef = useRef(0)

  useEffect(() => {
    if (scan.generation === 0 || !scan.entries) return
    if (initGenRef.current === scan.generation) return
    initGenRef.current = scan.generation
    setSel(null)
    setContent(null)
    setContentErr(null)
    const dirs = scan.entries.filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))
    setOpen(new Set(dirs.filter((p) => !p.includes('/'))))
  }, [scan.generation, scan.entries])

  const tree = useMemo(() => buildTree(scan.entries ?? []), [scan.entries])
  const keep = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query || !scan.entries) return null
    const set = new Set<string>()
    for (const entry of scan.entries) {
      if (entry.type !== 'file' || !entry.path.toLowerCase().includes(query)) continue
      set.add(entry.path)
      for (const ancestor of ancestorsOf(entry.path)) set.add(ancestor)
    }
    return set
  }, [q, scan.entries])

  const select = useCallback((path: string) => {
    setSel(path)
    setContent(null)
    setContentErr(null)
    if (IMAGE_EXT.has(extOf(path))) return
    getCabinFile(cabinId, path)
      .then((res) => setContent(res.content))
      .catch((err: unknown) => setContentErr(err instanceof Error ? err.message : '读取失败'))
  }, [cabinId])

  return (
    <div className="ck12-files" data-testid="cockpit-session-files-tree">
      <div className="ck12-pnote">
        会话没有专属 worktree · 这里只读本舱 cwd；要看项目 worktree 去对应作业的「项目」页签。
      </div>
      <div className="ck12-files-h">
        <span className="ck12-files-dir" title={scan.dir}>{scan.dir || '本舱 cwd'}</span>
        <input
          className="ck12-files-q"
          value={q}
          placeholder="筛文件（自动展开匹配链）"
          aria-label="筛选本舱文件"
          onChange={(event) => setQ(event.target.value)}
        />
        <button
          type="button"
          className="ck12-files-re"
          title="重扫磁盘"
          onClick={() => scan.reload({ fresh: true })}
        >
          ↻
        </button>
      </div>
      <div className="ck12-files-b">
        <div className="ck12-files-tree" role="tree" aria-label="本舱目录树">
          {scan.loading && !scan.entries && <div className="ck12-files-empty">扫磁盘…</div>}
          {scan.error && <div className="ck12-files-empty is-err">{scan.error}</div>}
          {!scan.loading && !scan.error && scan.entries && scan.entries.length === 0 && (
            <div className="ck12-files-empty">本舱目录空着</div>
          )}
          {!scan.loading && !scan.error && keep && keep.size === 0 && (
            <div className="ck12-files-empty">没有匹配「{q}」的文件</div>
          )}
          {!scan.error && (
            <TreeRows
              nodes={tree}
              depth={0}
              open={open}
              onToggle={(path) => setOpen((prev) => {
                const next = new Set(prev)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })}
              sel={sel}
              onSelect={select}
              keep={keep}
            />
          )}
        </div>
        <div className="ck12-files-preview">
          {sel ? (
            <>
              <div className="ck12-files-ph">
                <b>{sel}</b>
                <span>只读 · 本舱文件</span>
              </div>
              {contentErr && <div className="ck12-files-empty is-err">{contentErr}</div>}
              {!contentErr && IMAGE_EXT.has(extOf(sel)) && (
                <div className="ck12-sess-img">
                  <img src={cabinRawUrl(cabinId, sel)} alt={sel} />
                </div>
              )}
              {!contentErr && !IMAGE_EXT.has(extOf(sel)) && content == null && (
                <div className="ck12-files-empty">读文件…</div>
              )}
              {!contentErr && content != null && <pre className="ck12-files-pre">{content}</pre>}
            </>
          ) : (
            <div className="ck12-files-empty">点一个文件看内容（只读，不改本舱）</div>
          )}
        </div>
      </div>
    </div>
  )
}
