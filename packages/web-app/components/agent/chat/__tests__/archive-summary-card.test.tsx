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
})
