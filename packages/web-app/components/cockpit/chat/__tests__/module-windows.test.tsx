// 2026-11-23 用户 #10：全舱任务模块窗 —— chat 状态卡 / 作业详情「打开运行 →」
// 统一开 .ck12-twin 舱系浮窗（可拖 / 可缩 / ✕ 左置），不再 classic 大 Dialog。
//   · surface context 打开即出窗；
//   · YAML 目标渲染执行快照；
//   · 关闭即卸载（Esc 也走同一 close）。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { Mock } from 'vitest'
import { CockpitTaskWindows } from '../module-windows'
import { useTaskModuleSurface } from '@/lib/task-module-surface'
import { fetchExecutionDetail } from '@/lib/api-client'
import { getTask, getTaskArchive } from '@/lib/tasks-api'

vi.mock('@/lib/api-client', () => ({ fetchExecutionDetail: vi.fn() }))
vi.mock('@/lib/tasks-api', () => ({ getTask: vi.fn(), getTaskArchive: vi.fn() }))
vi.mock('../../state/CockpitStateProvider', () => ({
  useCockpitState: () => ({ layer: { register: () => () => {} } }),
}))

function Opener() {
  const api = useTaskModuleSurface()
  return (
    <>
      <button
        type="button"
        data-testid="open-yaml"
        onClick={() => api?.open({
          module: 'yaml',
          yamlTarget: { workspaceId: 'w-1', executionId: 'e-1', workflowRef: 'built-in/matt-spec-dev' },
        })}
      >
        open
      </button>
      <button
        type="button"
        data-testid="open-archive"
        onClick={() => api?.open({ module: 'archive', taskId: 't-arch' })}
      >
        archive
      </button>
    </>
  )
}

describe('CockpitTaskWindows', () => {
  it('surface.open(yaml) → 舱系浮窗 + 执行快照内容；关闭即卸载', async () => {
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      status: 'completed', workflow_ref: 'built-in/matt-spec-dev',
      workflow_content: 'name: matt-spec-dev\nnodes: []\n', steps: [],
    })
    render(
      <CockpitTaskWindows>
        <Opener />
      </CockpitTaskWindows>,
    )
    fireEvent.click(screen.getByTestId('open-yaml'))
    const win = await screen.findByTestId('cockpit-twin-yaml')
    expect(win.className).toContain('ck12-twin')
    await waitFor(() => expect(win.textContent).toContain('name: matt-spec-dev'))
    expect(fetchExecutionDetail).toHaveBeenCalledWith('w-1', 'e-1')

    fireEvent.click(within(win).getByLabelText('关闭'))
    expect(screen.queryByTestId('cockpit-twin-yaml')).toBeNull()
  })

  it('surface.open(archive) → 舱系浮窗用 v22 归档面（同一份归档读模型）', async () => {
    ;(getTask as Mock).mockResolvedValue({
      id: 't-arch', name: '待归档任务', status: 'awaiting_archive',
      task_spec: {}, executions: [],
    })
    ;(getTaskArchive as Mock).mockResolvedValue({
      task_id: 't-arch',
      status: 'awaiting_archive',
      in_flight: false,
      projects: [],
      state: null,
      report: null,
      report_md: null,
      reflection: null,
      knowledge: null,
      amendments: [],
      cleanup: null,
      cleanup_in_flight: false,
    })
    render(
      <CockpitTaskWindows>
        <Opener />
      </CockpitTaskWindows>,
    )
    fireEvent.click(screen.getByTestId('open-archive'))
    const win = await screen.findByTestId('cockpit-twin-archive')
    expect(win.className).toContain('ck12-twin')
    await waitFor(() => expect(win.textContent).toContain('待归档 · 未启动'))
    expect(getTaskArchive).toHaveBeenCalledWith('t-arch')
    fireEvent.click(within(win).getByLabelText('关闭'))
    expect(screen.queryByTestId('cockpit-twin-archive')).toBeNull()
  })
})
