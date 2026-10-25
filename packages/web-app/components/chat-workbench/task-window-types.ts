import type { Rect } from '@/lib/window-geometry'

export type TaskModule = 'changes' | 'artifacts' | 'files' | 'workflow' | 'acceptance'

export interface TaskWindowRecord {
  module: TaskModule
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
  z: number
}

export type TaskWindowMap = Partial<Record<TaskModule, TaskWindowRecord>>
