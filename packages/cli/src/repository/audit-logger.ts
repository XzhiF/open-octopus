/**
 * AuditLogger — JSONL 审计日志
 *
 * 每次资源操作追加一行 JSON 到审计日志文件。
 * 支持查询最近 N 条记录。
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import type { ResourceAuditEntryV2 as AuditEntry, ResourceAuditActionV2 as AuditAction, ResourceType } from "@octopus/shared"
import { nowISO } from "@octopus/shared"

export class AuditLogger {
  private logPath: string

  constructor(logPath: string) {
    this.logPath = logPath
    mkdirSync(dirname(logPath), { recursive: true })
  }

  /** 追加一条审计日志 */
  log(
    action: AuditAction,
    detail: {
      name?: string
      type?: ResourceType
      hash?: string
      source?: string
      detail?: Record<string, unknown>
    }
  ): void {
    const entry: AuditEntry = {
      timestamp: nowISO(),
      action,
      caller: (process.env.OCTOPUS_CALLER as "human" | "agent") || "human",
      status: "success",
      ...detail,
    }
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8")
  }

  /** 读取最近 N 条审计日志 */
  readLast(n: number = 20): AuditEntry[] {
    if (!existsSync(this.logPath)) return []

    const lines = readFileSync(this.logPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)

    const entries: AuditEntry[] = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // 跳过损坏的行
      }
    }

    return entries.slice(-n)
  }

  /** 获取日志文件路径 */
  getLogPath(): string {
    return this.logPath
  }
}
