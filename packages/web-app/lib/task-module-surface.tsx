'use client'

// 任务模块的「打开位置」抽象（2026-11-23 用户 #10）：
//   桌面模式 → ChatPane 自己开 TaskModulesLayer 浮窗（classic）；
//   全舱模式 → CockpitTaskWindows 提供本 context，同一个点击开舱系浮窗。
// 组件只依赖这个 context，不关心宿主怎么画窗。

import { createContext, useContext } from 'react'
import type { RunTarget, YamlTarget } from '@/components/chat-workbench/task-window-types'

export type TaskModuleSurfaceModule = 'plan' | 'run' | 'acceptance' | 'yaml'

export interface TaskModuleOpenSpec {
  module: TaskModuleSurfaceModule
  /** 任务内模块（规格 / 运行 / 验收）的锚点。 */
  taskId?: string | null
  /** 指定执行（作业坞 / 详情「打开运行 →」）。 */
  runTarget?: RunTarget | null
  /** 工作流 YAML 快照。 */
  yamlTarget?: YamlTarget | null
}

export interface TaskModuleSurfaceApi {
  open(spec: TaskModuleOpenSpec): void
}

export const TaskModuleSurfaceContext = createContext<TaskModuleSurfaceApi | null>(null)

/** null = 桌面模式（调用方回落到内联 / TaskModulesLayer）。 */
export function useTaskModuleSurface(): TaskModuleSurfaceApi | null {
  return useContext(TaskModuleSurfaceContext)
}
