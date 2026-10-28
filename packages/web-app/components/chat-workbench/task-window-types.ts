import type { Rect } from '@/lib/window-geometry'

export type TaskModule =
  | 'plan'
  | 'changes'
  | 'run'
  | 'acceptance'
  | 'usage'
  | 'artifacts'
  | 'archive'

export interface TaskWindowRecord {
  module: TaskModule
  rect: Rect
  minimized: boolean
  maximized: boolean
  restoreRect: Rect | null
  z: number
}

export type TaskWindowMap = Partial<Record<TaskModule, TaskWindowRecord>>
