// packages/web-app/components/agent/chat/__tests__/archive-summary-card.test.tsx
//
// 归档总框（2026-10-31 AI-native 归档 v2）：对话里唯一的归档卡 ——
// 状态 + 4 个指标 + 一句人话 + 「打开归档台」文字链接；没有决定按钮。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'
import type { TaskArchivePayload } from '@/lib/tasks-api'

const { mockGetTaskArchive } = vi.hoisted(() => ({ mockGetTaskArchive: vi.fn() }))
vi.mock('@/lib/tasks-api', () => ({ getTaskArchive: mockGetTaskArchive }))

import { ArchiveSummaryCard } from '../archive-summary-card'

function message(overrides: Partial<AgentMessage['activity']> = {}): AgentMessage {
  return {
    id: 'm-archive',
    session_id: 's-1',
    role: 'user',
    content: '[事件] 归档 · 总览',
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity: {
      kind: 'task.status',
      severity: 'info',
      title: '归档 · 总览',
      taskId: 't-1',
      status: 'archiving',
      payload: { archiveSummary: true, actions: [{ id: 'open_archive', label: '打开归档台看明细' }] },
      ...overrides,
    },
  }
}

function payload(overrides: Partial<TaskArchivePayload> = {}): TaskArchivePayload {
  return {
    task_id: 't-1',
    status: 'archiving',
    in_flight: true,
    projects: ['api', 'web'],
    state: { date: '20261031', projects: { api: { status: 'done', commit: 'abcdef1234567890' } } },
    report: null,
    report_md: null,
    reflection: {
      task_id: 't-1',
      created_at: new Date().toISOString(),
      entries: [
        { id: 'refl-1', title: '长词优先匹配', content: 'x' },
        { id: 'refl-2', title: '修复轮不换流', content: 'y' },
        { id: 'refl-3', title: '术语：打回单', content: 'z' },
      ],
      decisions: {},
    },
    knowledge: { pack_items: 7, compile_state: 'queued', compile_position: 2 },
    amendments: [],
    cleanup: null,
    cleanup_in_flight: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockGetTaskArchive.mockReset()
})

describe('ArchiveSummaryCard', () => {
  it('renders the four metrics and a plain-language progress line', async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('1/2')).toBeTruthy() // git 同步
    expect(screen.getByText('0/3')).toBeTruthy() // 反思决策
    expect(screen.getByText('—')).toBeTruthy() // 术语冲突（还没有 report）
    expect(screen.getByText('排队')).toBeTruthy() // 知识编译
    expect(screen.getByText(/正在同步到 2 个 project/)).toBeTruthy()
    expect(screen.getByText(/3 条反思待决定/)).toBeTruthy()
  })

  it('opens the archive window from the single text link', async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    const onAction = vi.fn()
    window.addEventListener('octopus:task-card-action', onAction)
    render(<ArchiveSummaryCard message={message()} />)
    fireEvent.click(await screen.findByTestId('archive-summary-open'))
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
    const detail = (onAction.mock.calls[0][0] as CustomEvent).detail as Record<string, unknown>
    expect(detail.actionId).toBe('open_archive')
    expect(detail.taskId).toBe('t-1')
    window.removeEventListener('octopus:task-card-action', onAction)
  })

  it('shows a stopped state with the failing project and no buttons', async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      in_flight: false,
      state: { date: '20261031', projects: { api: { status: 'done', commit: 'abc' } } },
      report: {
        taskId: 't-1', date: '20261031', ok: false,
        projects: [
          { project: 'api', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: 'abc', pushed: true, pr: { action: 'created', url: 'https://x/pr/1' } },
          { project: 'web', ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: false, pr: null, error: 'git push origin feat/x failed: protected branch' },
        ],
        unattributedAdrs: [], unattributedNotes: 0,
      },
    }))
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('停在归档')).toBeTruthy()
    expect(screen.getByText(/web — git push origin feat\/x failed/)).toBeTruthy()
    // 总计、卡面只有链接，没有决定按钮
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /落 wiki|跳过|重试/ })).toBeNull()
  })

  it('asks the human to include/exclude when preflight blocks on dirty worktrees', async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      in_flight: false,
      report: {
        taskId: 't-1', date: '20261031', ok: false,
        projects: [
          { project: 'api', ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: false, pr: null, error: '工作区有未提交改动 — 待纳入/排除' },
        ],
        unattributedAdrs: [], unattributedNotes: 0,
        preflight: { blocked: true, dirty_projects: ['api'], message: '工作区还有未提交改动' },
        delta: [{ project: 'api', dir: 'C:/wt', from: 'a', head: 'b', commits: 1, subjects: ['x'], dirty_files: ['M a.ts'] }],
        delta_decision: null,
      },
    }))
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText(/api 还有未提交改动/)).toBeTruthy()
    expect(screen.getByText(/对我说「纳入」或「排除」/)).toBeTruthy()
  })

  it('settles on done and reports term conflicts waiting for PR review', async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      status: 'done',
      in_flight: false,
      // 知识沉淀也跑完了（编译 done、无未决 finding）→ 才是干净的「已完成」。
      knowledge: { pack_items: 7, compile_state: 'committed', compile_position: null },
      state: { date: '20261031', projects: { api: { status: 'done' }, web: { status: 'done' } } },
      reflection: {
        task_id: 't-1', created_at: new Date().toISOString(),
        entries: [{ id: 'refl-1', title: 'A', content: 'x' }],
        decisions: { 'refl-1': { action: 'ingest', at: new Date().toISOString(), raw_path: 'raw/inbox/a.md' } },
      },
      report: {
        taskId: 't-1', date: '20261031', ok: true,
        projects: [
          { project: 'api', ok: true, adrMerged: 1, adrSkipped: [], termsAppended: 1, termConflicts: [{ term: '打回单', incoming: 'a', existing: 'b' }], commit: 'abc', pushed: true, pr: { action: 'merged-into-open', url: 'https://x/pr/1' } },
          { project: 'web', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: true, pr: { action: 'none' } },
        ],
        unattributedAdrs: [], unattributedNotes: 0,
      },
    }))
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('已完成')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.getByText('1/1')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy() // 术语冲突
    expect(screen.getByText(/归档完成，任务已 done；1 处术语冲突已在归档 PR 等 review/)).toBeTruthy()
  })

  // 2026-11-10 用户：归档已经显示「已完成」，过了一阵子才冒出冲突裁决请求，
  // 感觉顺序不对。done 只判定 git —— 知识沉淀还在编译 / 有未决矛盾时，卡面
  // 必须把第二阶段如实标出来，不能笼统播「全都完事」。
  it('done 但知识沉淀仍在编译 → chip 标出「知识编译中」，不谎称全部完成', async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      status: 'done',
      in_flight: false,
      state: { date: '20261031', projects: { api: { status: 'done' }, web: { status: 'done' } } },
      report: {
        taskId: 't-1', date: '20261031', ok: true,
        projects: [
          { project: 'api', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: true, pr: { action: 'none' } },
          { project: 'web', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: true, pr: { action: 'none' } },
        ],
        unattributedAdrs: [], unattributedNotes: 0,
      },
      knowledge: { pack_items: 6, compile_state: 'running', compile_position: null },
    }))
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('已完成 · 知识编译中')).toBeTruthy()
    expect(screen.getByText(/知识沉淀仍在编译，完成后若有矛盾会单独请你裁决/)).toBeTruthy()
  })

  it('done 且有未决矛盾 → chip 显示待裁决数量；裁决后归零显示已全部裁决', async () => {
    const donePayload = (knowledge: NonNullable<TaskArchivePayload['knowledge']>) => payload({
      status: 'done',
      in_flight: false,
      state: { date: '20261031', projects: { api: { status: 'done' }, web: { status: 'done' } } },
      report: {
        taskId: 't-1', date: '20261031', ok: true,
        projects: [
          { project: 'api', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: true, pr: { action: 'none' } },
          { project: 'web', ok: true, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: true, pr: { action: 'none' } },
        ],
        unattributedAdrs: [], unattributedNotes: 0,
      },
      knowledge,
    })
    const finding = {
      id: 'fnd-1', kind: 'contradiction', status: 'open', title: '矛盾：a ↔ b',
      detail: {}, pages: ['a.md', 'b.md'], rawRef: '', source: 'compile',
      createdAt: new Date().toISOString(),
    }
    mockGetTaskArchive.mockResolvedValue(donePayload({
      pack_items: 6, compile_state: 'committed',
      findings: [finding],
      wiki_result: {
        status: 'committed', started_at: '2026-11-10T07:36:00.000Z', finished_at: '2026-11-10T07:40:00.000Z',
        commit: 'abc', changed: true, deduped: false, created: 1, updated: 1, contradictions: 1,
        finding_ids: ['fnd-1'], touched: [], warnings: [],
      },
    }))
    const { unmount } = render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('已完成 · 知识待裁决 1')).toBeTruthy()
    expect(screen.getByText(/知识沉淀有 1 处矛盾待裁决/)).toBeTruthy()
    unmount()

    // 采纳修订完成后服务端 findings 活列表为空 —— chip 回到「已完成」。
    mockGetTaskArchive.mockResolvedValue(donePayload({
      pack_items: 6, compile_state: 'committed',
      findings: [],
      wiki_result: {
        status: 'committed', started_at: '2026-11-10T07:36:00.000Z', finished_at: '2026-11-10T07:40:00.000Z',
        commit: 'abc', changed: true, deduped: false, created: 1, updated: 1, contradictions: 1,
        finding_ids: ['fnd-1'], touched: [], warnings: [],
      },
    }))
    render(<ArchiveSummaryCard message={message()} />)
    expect(await screen.findByText('已完成')).toBeTruthy()
    expect(screen.getByText(/知识沉淀已完成，矛盾已全部裁决/)).toBeTruthy()
  })
})
