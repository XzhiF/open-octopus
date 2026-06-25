/**
 * 共享内存条目 — 存储 value + 写入者元数据
 */
export interface SharedMemoryEntry {
  value: unknown
  author: string
  timestamp: number
}

/**
 * 内存键值存储 — Expert 间数据共享的基础设施
 *
 * 在多智能体 swarm 执行中提供共享数据存储空间。
 * 每个条目记录写入者和时间戳，支持快照用于 checkpoint 恢复。
 */
export class SharedMemory {
  private store = new Map<string, SharedMemoryEntry>()

  /** 读取键值（返回 undefined 若不存在） */
  get(key: string): unknown {
    return this.store.get(key)?.value
  }

  /** 写入键值，记录 author 和当前时间戳 */
  set(key: string, value: unknown, author: string): void {
    this.store.set(key, { value, author, timestamp: Date.now() })
  }

  /** 检查键是否存在 */
  has(key: string): boolean {
    return this.store.has(key)
  }

  /** 列出所有键名 */
  keys(): string[] {
    return Array.from(this.store.keys())
  }

  /** 创建当前状态的只读快照（用于 checkpoint） */
  snapshot(): ReadonlyMap<string, SharedMemoryEntry> {
    return new Map(this.store)
  }
}
