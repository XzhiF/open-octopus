// 2026-11-24 用户二轮：作战详情「归档」复刻 classic 归档台（概览 / 知识落点 / 明细），
// 皮肤走 v22 舱系。素材包逐件可点 → 只读二级窗；归档报告 → 二级窗；关闭按钮一律左上角。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { getTaskArchive, type TaskArchivePayload, type TaskView } from '@/lib/tasks-api'
import { getKcFsFile } from '@/lib/knowledge/knowledge-center-api'
import { CockpitArchivePanel } from '../CockpitArchivePanel'

vi.mock('@/lib/tasks-api', () => ({ getTaskArchive: vi.fn() }))
vi.mock('@/lib/knowledge/knowledge-center-api', () => ({ getKcFsFile: vi.fn() }))

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-arch',
    name: '对账导出',
    status: 'awaiting_archive',
    project_ids: ['ledger'],
    created_at: '2026-11-24T08:00:00.000Z',
    updated_at: '2026-11-24T09:58:00.000Z',
    task_spec: { branch: 'feat/reconcile-export', base_branch: 'main', target_branch: 'main' },
    ...over,
  } as unknown as TaskView
}

function payload(over: Partial<TaskArchivePayload> = {}): TaskArchivePayload {
  return {
    task_id: 't-arch',
    status: 'awaiting_archive',
    in_flight: false,
    projects: ['ledger'],
    state: null,
    report: null,
    report_md: null,
    reflection: null,
    knowledge: null,
    amendments: [],
    cleanup: null,
    cleanup_in_flight: false,
    ...over,
  }
}

const donePayload = () =>
  payload({
    status: 'done',
    state: {
      startedAt: '2026-11-24T08:51:00.000Z',
      projects: {
        ledger: { status: 'done', commit: '7c9d21e', completedAt: '2026-11-24T09:02:00.000Z' },
      },
    },
    report: {
      taskId: 't-arch',
      date: '2026-11-24',
      ok: true,
      unattributedAdrs: [],
      unattributedNotes: 0,
      projects: [
        {
          project: 'ledger',
          ok: true,
          adrMerged: 1,
          adrSkipped: [],
          termsAppended: 2,
          termConflicts: [],
          commit: '7c9d21e',
          pushed: true,
          pr: { action: 'merged', url: 'https://example.com/pr/126' },
        },
      ],
    },
    knowledge: {
      pack_items: 3,
      pack_path: 'raw/archives/2026-11-24-M1',
      pack_created_at: '2026-11-24T09:03:00.000Z',
      items: [
        { kind: 'spec', name: 'spec.md', bytes: 7214, excluded: false, path: 'raw/archives/2026-11-24-M1/spec.md' },
        { kind: 'log', name: 'verify.log', bytes: 91_233, excluded: false, path: 'raw/archives/2026-11-24-M1/verify.log' },
        { kind: 'diff', name: 'huge.diff', bytes: 120_000, excluded: true, path: 'raw/archives/2026-11-24-M1/huge.diff' },
      ],
      compile_state: 'committed',
      compile_position: null,
      wiki_result: {
        status: 'committed',
        started_at: '2026-11-24T09:04:00.000Z',
        finished_at: '2026-11-24T09:07:40.000Z',
        commit: 'abc123',
        changed: true,
        deduped: false,
        created: 1,
        updated: 3,
        contradictions: 0,
        finding_ids: [],
        touched: [
          { path: 'wiki/concepts/结算口径.md', type: 'concepts', created: false },
          { path: 'wiki/entities/结算单.md', type: 'entities', created: false },
          { path: 'wiki/topics/对账导出.md', type: 'topics', created: false },
          { path: 'wiki/cases/重复退款.md', type: 'cases', created: true },
        ],
        warnings: [],
      },
      findings: [],
      case_results: [
        {
          queue_task_id: 'q1',
          action: 'created',
          symptom: '重放不幂等',
          case_path: 'cases/x.md',
          occurrences_before: null,
          occurrences_after: null,
          finished_at: '2026-11-24T09:07:50.000Z',
        },
      ],
    },
    reflection: {
      task_id: 't-arch',
      created_at: '2026-11-24T08:00:00.000Z',
      entries: [{ id: 'r1', title: '结算口径以 v3 为准', content: '正文', target: 'wiki/concepts/结算口径.md' }],
      decisions: { r1: { action: 'ingest', at: '2026-11-24T09:00:00.000Z' } },
    },
    cleanup: {
      taskId: 't-arch',
      startedAt: '2026-11-24T09:02:00.000Z',
      finishedAt: '2026-11-24T09:02:30.000Z',
      status: 'done',
      total_freed_bytes: 42_600_000,
      projects: [
        {
          project: 'ledger',
          dir: null,
          ok: true,
          removed_count: 4,
          freed_bytes: 42_600_000,
          leftover_count: 0,
        },
      ],
    },
    report_md: '# 2026-11-24 · M1 归档报告\n\n- ledger 7c9d21e\n',
  })

describe('CockpitArchivePanel', () => {
  beforeEach(() => {
    vi.mocked(getTaskArchive).mockReset()
    vi.mocked(getKcFsFile).mockReset()
    vi.mocked(getKcFsFile).mockResolvedValue({
      path: 'raw/archives/2026-11-24-M1/spec.md',
      content: '---\nsha256: abc\n---\n# 对账导出 spec\n\n正文要点',
      bytes: 7214,
    })
  })

  it('待归档：粉签 + 人工闸 + 步骤 + 项目同步计划 + 三层页签', async () => {
    ;(getTaskArchive as Mock).mockResolvedValue(payload())
    render(<CockpitArchivePanel task={task()} />)
    await waitFor(() => expect(getTaskArchive).toHaveBeenCalledWith('t-arch'))

    const chip = await screen.findByTestId('ck12-archive-chip')
    expect(chip.textContent).toContain('待归档 · 未启动')
    expect(chip.className).toContain('is-pending')
    expect(screen.getByText(/验收 ≠ 归档/)).toBeTruthy()
    expect(screen.getByText('❯ 归档')).toBeTruthy()
    for (let i = 1; i <= 4; i += 1) {
      expect(screen.getByTestId(`ck12-archive-step-${i}`)).toBeTruthy()
    }
    const table = screen.getByTestId('ck12-archive-projects')
    expect(table.textContent).toContain('ledger')
    expect(table.textContent).toContain('feat/reconcile-export')
    expect(table.textContent).toContain('⎇ main → 合入 main')
    expect(screen.getByTestId('ck12-archive-tab-overview')).toBeTruthy()
    expect(screen.getByTestId('ck12-archive-tab-knowledge')).toBeTruthy()
    expect(screen.getByTestId('ck12-archive-tab-detail')).toBeTruthy()
    // 只读：没有「推进 / 下一步」这类演示动作。
    expect(screen.queryByText(/推进/)).toBeNull()
  })

  it('归档中：天蓝签 + 步骤进度 + 真实时间戳事件', async () => {
    ;(getTaskArchive as Mock).mockResolvedValue(
      payload({
        status: 'archiving',
        in_flight: true,
        state: {
          startedAt: '2026-11-24T09:31:00.000Z',
          projects: {
            ledger: {
              status: 'done',
              commit: 'a41f2c9f00',
              completedAt: '2026-11-24T09:33:00.000Z',
            },
          },
        },
        report: {
          taskId: 't-arch',
          date: '2026-11-24',
          ok: false,
          unattributedAdrs: [],
          unattributedNotes: 0,
          projects: [
            {
              project: 'ledger',
              ok: true,
              adrMerged: 1,
              adrSkipped: [],
              termsAppended: 2,
              termConflicts: [],
              commit: 'a41f2c9f00',
              pushed: true,
              pr: { action: 'created', url: 'https://example.com/pr/128' },
            },
          ],
        },
      }),
    )
    render(<CockpitArchivePanel task={task({ status: 'archiving' })} />)

    const chip = await screen.findByTestId('ck12-archive-chip')
    expect(chip.textContent).toContain('归档编排中')
    expect(chip.className).toContain('is-running')
    expect(screen.getByTestId('ck12-archive-step-1').className).toContain('is-ok')

    const verdict = screen.getByTestId('ck12-archive-verdict')
    expect(verdict.textContent).toContain('归档编排中')
    const events = screen.getByTestId('ck12-archive-events')
    expect(events.textContent).toContain('归档启动')
    expect(events.textContent).toContain('commit a41f2c9')

    const table = screen.getByTestId('ck12-archive-projects')
    expect(table.textContent).toContain('a41f2c9f')
    expect(table.textContent).toContain('created')
  })

  it('已归档：结论行 / KPI / 素材件二级窗（✕ 左上）/ 报告二级窗', async () => {
    ;(getTaskArchive as Mock).mockResolvedValue(donePayload())
    render(<CockpitArchivePanel task={task({ status: 'done' })} />)

    const chip = await screen.findByTestId('ck12-archive-chip')
    expect(chip.textContent).toContain('已归档')
    expect(chip.className).toContain('is-done')

    const verdict = screen.getByTestId('ck12-archive-verdict')
    expect(verdict.textContent).toContain('归档完成')
    expect(verdict.textContent).toContain('1/1 project 同步成功')
    expect(verdict.textContent).toContain('知识已落库')
    expect(verdict.textContent).toContain('4 页')

    const kpi = screen.getByTestId('ck12-archive-kpi')
    expect(kpi.textContent).toContain('40.6 MB')
    expect(screen.getByTestId('ck12-archive-timeline').textContent).toContain('编排开始')

    // 明细页签：素材包逐件可点，点开只读二级窗。
    fireEvent.click(screen.getByTestId('ck12-archive-tab-detail'))
    const items = screen.getAllByTestId('ck12-archive-pack-item')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('spec.md')
    expect(items[1].textContent).toContain('仅指针')
    expect(items[2].textContent).toContain('已剔除')

    fireEvent.click(items[0])
    const fileWin = await screen.findByTestId('ck12-archive-file-win')
    await waitFor(() => expect(getKcFsFile).toHaveBeenCalledWith('raw/archives/2026-11-24-M1/spec.md'))
    await waitFor(() => expect(fileWin.textContent).toContain('正文要点'))
    // 舱系规范：关闭按钮在窗头最左。
    const fileHead = fileWin.querySelector('.ck12-arcwin-h')
    expect(fileHead?.firstElementChild?.getAttribute('data-testid')).toBe('ck12-archive-file-win-close')
    fireEvent.click(screen.getByTestId('ck12-archive-file-win-close'))
    await waitFor(() => expect(screen.queryByTestId('ck12-archive-file-win')).toBeNull())

    // 报告二级窗。
    fireEvent.click(screen.getByTestId('ck12-archive-report'))
    const reportWin = await screen.findByTestId('ck12-archive-report-win')
    expect(reportWin.textContent).toContain('M1 归档报告')
    expect(reportWin.textContent).toContain('ledger 7c9d21e')
    const reportHead = reportWin.querySelector('.ck12-arcwin-h')
    expect(reportHead?.firstElementChild?.getAttribute('data-testid')).toBe('ck12-archive-report-win-close')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('ck12-archive-report-win')).toBeNull())
  })

  it('知识落点页签：页级回执分组 + 判例入档 + 清理明细', async () => {
    ;(getTaskArchive as Mock).mockResolvedValue(donePayload())
    render(<CockpitArchivePanel task={task({ status: 'done' })} />)
    await screen.findByTestId('ck12-archive-chip')

    fireEvent.click(screen.getByTestId('ck12-archive-tab-knowledge'))
    const knowledge = screen.getByTestId('ck12-archive-knowledge')
    expect(knowledge.textContent).toContain('更新 · 3')
    expect(knowledge.textContent).toContain('新建 · 1')
    expect(knowledge.textContent).toContain('wiki/concepts/结算口径.md')
    expect(knowledge.textContent).toContain('判例入档 · 1')
    expect(knowledge.textContent).toContain('重放不幂等')

    fireEvent.click(screen.getByTestId('ck12-archive-tab-detail'))
    const detail = screen.getByTestId('ck12-archive-detail')
    expect(detail.textContent).toContain('删除 4 项')
    expect(detail.textContent).toContain('结算口径以 v3 为准')
    expect(detail.textContent).toContain('已落 wiki')
  })

  it('还没到归档：琥珀提示 + 去「验收」跳转', async () => {
    ;(getTaskArchive as Mock).mockResolvedValue(payload({ status: 'running' }))
    const onOpenAcceptance = vi.fn()
    render(
      <CockpitArchivePanel
        task={task({ status: 'running' })}
        onOpenAcceptance={onOpenAcceptance}
      />,
    )
    expect(await screen.findByText('还没到归档')).toBeTruthy()
    fireEvent.click(screen.getByText('去「验收」→'))
    expect(onOpenAcceptance).toHaveBeenCalled()
  })
})
