import type { Rect } from '@/lib/window-geometry'

/** 运行窗的目标执行（2026-11-02）：作业坞运行列表点进来的任意一条，
 *  可能是任务轮次，也可能是 task_id=NULL 的验收规划。 */
export interface RunTarget {
  executionId: string
  workspaceId: string
  /** 窗口标题用（系统工作流的人话名字 · 坐标）。 */
  title: string
  workflowRef?: string
  phaseIndex?: number | null
  roundIndex?: number | null
  status?: string
  /** 系统运行 —— 不给「重跑」（那会误解成业务重跑）。 */
  system?: boolean
}

export type TaskModule =
  | 'plan'
  | 'changes'
  | 'run'
  | 'acceptance'
  | 'usage'
  | 'debug'
  | 'artifacts'
  | 'archive'

export interface TaskWindowRecord {
  module: TaskModule
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
  z: number
  /** 运行窗专用：指定要展示的执行；缺省 = 任务当前一轮。 */
  runTarget?: RunTarget | null
}

export type TaskWindowMap = Partial<Record<TaskModule, TaskWindowRecord>>
