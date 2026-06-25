import type { Message } from "./swarm-types"

/**
 * 内存消息总线 — Expert 间通信的核心基础设施
 *
 * 负责在多智能体 swarm 执行中路由、存储和检索消息。
 * 支持按发送者、接收者、轮次过滤，支持从 checkpoint 恢复。
 */
export class MessageBus {
  private messages: Message[] = []

  /** 发送一条消息到总线 */
  send(msg: Message): void {
    this.messages.push(msg)
  }

  /**
   * 按条件过滤消息线程
   *
   * - from:  精确匹配发送者
   * - to:    精确匹配接收者（含广播 "*"）
   * - round: 精确匹配轮次
   *
   * 返回结果按 timestamp 升序排列。
   */
  getThread(filter: { from?: string; to?: string; round?: number }): Message[] {
    return this.messages
      .filter(m => {
        if (filter.from && m.from !== filter.from) return false
        if (filter.to && m.to !== filter.to && m.to !== "*") return false
        if (filter.round !== undefined && m.round !== filter.round) return false
        return true
      })
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  /** 获取所有消息，按 timestamp 升序排列 */
  getAll(): Message[] {
    return [...this.messages].sort((a, b) => a.timestamp - b.timestamp)
  }

  /** 清空所有消息 */
  clear(): void {
    this.messages = []
  }

  /** 从 checkpoint 数据恢复消息状态 */
  loadFromCheckpoint(messages: Message[]): void {
    this.messages = [...messages]
  }
}
