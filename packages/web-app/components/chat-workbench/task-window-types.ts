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
  /** 任务绑定执行 = 任务 id；恢复要走任务动作（重挂 callbacks），不能只走执行接口。 */
  taskId?: string | null
  /** 系统运行 —— 不给「重跑」（那会误解成业务重跑）。 */
  system?: boolean
}

/** 子代理详情窗的目标（2026-11-04 作业坞「子代理」）。 */
export interface SubagentTarget {
  /** SDK task_id（= transcript 的 agentId）。 */
  id: string
  /** 窗口标题用的描述。 */
  title?: string
}

/** YAML 窗的目标（2026-11-07）：任意一次执行的主工作流 + 运行时动态子流。 */
export interface YamlTarget {
  workspaceId: string
  executionId: string
  workflowRef?: string | null
  title?: string
  phaseIndex?: number | null
  roundIndex?: number | null
  status?: string
  /** 打开来源决定初始位置：运行列表 = 居中；运行窗 = 右下（把 DAG 留出来）。 */
  from?: "dock" | "run"
}

export type TaskModule =
  | 'plan'
  | 'workflow'
  | 'changes'
  | 'run'
  | 'acceptance'
  | 'usage'
  | 'debug'
  | 'artifacts'
  | 'archive'
  | 'subagents'

export interface TaskWindowRecord {
  module: TaskModule
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
  z: number
  /** 运行窗专用：指定要展示的执行；缺省 = 任务当前一轮。 */
  runTarget?: RunTarget | null
  /** 子代理窗专用：指定要展示的子代理；缺省 = 未选。 */
  subagentTarget?: SubagentTarget | null
}

export type TaskWindowMap = Partial<Record<TaskModule, TaskWindowRecord>>
