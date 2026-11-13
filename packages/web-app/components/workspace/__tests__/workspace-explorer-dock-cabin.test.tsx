// 作业坞隔离（2026-11-13 用户约束）：工作舱的舱模块段只影响「舱里的作业坞」，
// 桌面（会话 / 开发任务 / 工作流开发）的作业坞保持舱前原样 —— 原入口一个不少、
// 不多出舱段、层级也没变。这里把这条边界钉在组件层，防止后续舱开发顺手改公共坞。

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BookOpen, Boxes } from 'lucide-react'
import type { TaskView } from '@/lib/tasks-api'

vi.mock('@/lib/yjs-provider', () => ({
  useYDoc: () => ({ doc: null, provider: null, connected: false, synced: false }),
  useYMap: () => ({ map: null, version: 0 }),
}))
vi.mock('@/lib/api-client', () => ({
  fetchFileContent: vi.fn(),
  saveFileEntry: vi.fn(),
  getWorkspace: vi.fn().mockResolvedValue(undefined),
  openWorkspaceDirectory: vi.fn(),
}))
vi.mock('@/lib/agent/debug-api', () => ({
  listSessionDebugTurns: vi.fn().mockResolvedValue({ session_id: 's-1', total: 0, turns: [] }),
}))

import { WorkspaceExplorerDock, type CabinDockModule } from '../workspace-explorer-dock'

const draftTask = {
  id: 'task-1',
  name: '演示任务',
  status: 'draft',
  org: 'xzf',
} as unknown as TaskView

const activity = {
  queue: [],
  events: [],
  runningTasks: [],
  allRunningTasks: [],
  runningAgents: [],
  subagents: [],
  count: 0,
  globalCount: 0,
}

/** 舱前作业坞的常驻入口：文件 / 后台活动 / 调试 / 消耗。 */
const BASE_DOCK_IDS = ['dock-files', 'dock-activity', 'dock-debug', 'dock-usage']

describe('WorkspaceExplorerDock — 舱模块段只在舱内出现', () => {
  it('桌面（无 cabinModules）：原入口齐全，不多舱段，层级仍是 z-30', async () => {
    await act(async () => {
      render(<WorkspaceExplorerDock workspaceId="ws-1" task={draftTask} activity={activity} />)
    })

    const dock = screen.getByTestId('workspace-explorer-dock')
    for (const id of BASE_DOCK_IDS) expect(screen.getByTestId(id)).toBeTruthy()
    expect(screen.queryByTestId('dock-cabin-more')).toBeNull()
    expect(dock.querySelectorAll('[data-testid^="dock-cabin-"]')).toHaveLength(0)
    expect(dock.className).toContain('z-30')
    expect(dock.className).not.toContain('z-[65]')
  })

  it('舱内看任务线程（elevated、无舱模块）：坞内容原样，只抬层级', async () => {
    await act(async () => {
      render(<WorkspaceExplorerDock workspaceId="ws-1" task={draftTask} activity={activity} elevated />)
    })

    const dock = screen.getByTestId('workspace-explorer-dock')
    for (const id of BASE_DOCK_IDS) expect(screen.getByTestId(id)).toBeTruthy()
    expect(dock.querySelectorAll('[data-testid^="dock-cabin-"]')).toHaveLength(0)
    expect(dock.className).toContain('z-[65]')
  })

  it('舱内（注入 cabinModules）：原入口仍在，舱段追加其后，层级抬到 z-[65]', async () => {
    const onTasks = vi.fn()
    const onJobs = vi.fn()
    const modules: CabinDockModule[] = [
      { id: 'tasks', label: '任务', icon: BookOpen, onClick: onTasks },
      { id: 'jobs', label: '作业', icon: Boxes, onClick: onJobs },
    ]

    await act(async () => {
      render(
        <WorkspaceExplorerDock
          workspaceId="ws-1"
          task={draftTask}
          activity={activity}
          cabinModules={modules.slice(0, 1)}
          cabinMoreModules={modules.slice(1)}
        />,
      )
    })

    const dock = screen.getByTestId('workspace-explorer-dock')
    for (const id of BASE_DOCK_IDS) expect(screen.getByTestId(id)).toBeTruthy()
    expect(dock.className).toContain('z-[65]')

    fireEvent.click(screen.getByTestId('dock-cabin-tasks'))
    expect(onTasks).toHaveBeenCalledTimes(1)

    act(() => fireEvent.click(screen.getByTestId('dock-cabin-more')))
    act(() => fireEvent.click(screen.getByTestId('dock-cabin-jobs')))
    expect(onJobs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('dock-cabin-more-grid')).toBeNull()
  })
})
