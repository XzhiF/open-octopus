import type { Rect } from '@/lib/window-geometry'

export type TaskModule = 'plan' | 'changes' | 'acceptance' | 'experts'

export interface TaskWindowRecord {
  module: TaskModule
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
  z: number
}

export type TaskWindowMap = Partial<Record<TaskModule, TaskWindowRecord>>
