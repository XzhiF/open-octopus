/**
 * SecurityContext + TrustStore — 安全上下文
 *
 * SecurityContext 注入到 RepositoryManager / WorkspaceInstaller，
 * 在每次操作前执行安全检查:
 *   - 来源信任链（TOFU）
 *   - 调用者权限
 *   - 路径遍历防护
 *
 * TrustStore 管理 trusted-sources.yaml
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import * as yaml from "js-yaml"
import type {
  SourceRef,
  TrustedSources,
  TrustedSourceEntry,
  BlockedSourceEntry,
} from "@octopus/shared"
import { SecurityError, TrustedSourcesSchema, formatSourceRef, isPathWithinBase } from "@octopus/shared"

// ── TrustStore ──────────────────────────────────────────────────

export type TrustStatus = "trusted" | "blocked" | "unknown"

export class TrustStore {
  private filePath: string
  private data: TrustedSources

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = this.load()
  }

  /** 查找来源的信任状态 */
  lookup(ref: SourceRef): TrustStatus {
    // 先检查阻止列表
    for (const blocked of this.data.blocked) {
      if (this.matchesRef(blocked, ref)) return "blocked"
    }
    // 再检查信任列表
    for (const trusted of this.data.trusted) {
      if (this.matchesRef(trusted, ref)) return "trusted"
    }
    return "unknown"
  }

  /** 标记来源为可信 */
  remember(ref: SourceRef, status: "trusted"): void {
    const entry: Record<string, unknown> = {
      protocol: ref.protocol,
      trusted_at: new Date().toISOString().split("T")[0],
    }
    this.setRefFields(entry, ref)
    // @ts-expect-error — ref.protocol is SourceRef["protocol"] which matches TrustedSourceEntry at runtime
    this.data.trusted.push(entry)
    this.save()
  }

  /** 标记来源为阻止 */
  block(ref: SourceRef, reason: string): void {
    const entry: Record<string, unknown> = {
      protocol: ref.protocol,
      reason,
      blocked_at: new Date().toISOString().split("T")[0],
    }
    this.setRefFields(entry, ref)
    // @ts-expect-error — ref.protocol is SourceRef["protocol"] which matches BlockedSourceEntry at runtime
    this.data.blocked.push(entry)
    this.save()
  }

  /** 移除来源信任/阻止记录 */
  revoke(ref: SourceRef): boolean {
    let removed = false

    this.data.trusted = this.data.trusted.filter((t) => {
      if (this.matchesRef(t, ref)) {
        removed = true
        return false
      }
      return true
    })

    this.data.blocked = this.data.blocked.filter((b) => {
      if (this.matchesRef(b, ref)) {
        removed = true
        return false
      }
      return true
    })

    if (removed) this.save()
    return removed
  }

  /** 获取所有信任条目 */
  listTrusted(): TrustedSourceEntry[] {
    return [...this.data.trusted]
  }

  /** 获取所有阻止条目 */
  listBlocked(): BlockedSourceEntry[] {
    return [...this.data.blocked]
  }

  private matchesRef(entry: Record<string, unknown>, ref: SourceRef): boolean {
    if (entry.protocol !== ref.protocol) return false
    switch (ref.protocol) {
      case "npm": return entry.package === ref.package
      case "github": return entry.repo === ref.repo
      case "local": return entry.path === ref.path
      case "builtin": return entry.id === ref.id
      default: return false
    }
  }

  private setRefFields(entry: Record<string, unknown>, ref: SourceRef): void {
    switch (ref.protocol) {
      case "npm": entry.package = ref.package; break
      case "github": entry.repo = ref.repo; break
      case "local": entry.path = ref.path; break
      case "builtin": entry.id = ref.id; break
    }
  }

  private load(): TrustedSources {
    if (!existsSync(this.filePath)) {
      return { version: 1, trusted: [], blocked: [] }
    }
    try {
      const raw = yaml.load(readFileSync(this.filePath, "utf-8"))
      return TrustedSourcesSchema.parse(raw)
    } catch {
      return { version: 1, trusted: [], blocked: [] }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, yaml.dump(this.data, { lineWidth: 120 }), "utf-8")
  }
}

// ── SecurityContext ─────────────────────────────────────────────

export interface SecurityContextOptions {
  trustStore: TrustStore
  /** 是否跳过 TOFU 确认（非交互模式） */
  autoTrust?: boolean
}

export class SecurityContext {
  private trustStore: TrustStore
  private autoTrust: boolean

  constructor(opts: SecurityContextOptions) {
    this.trustStore = opts.trustStore
    this.autoTrust = opts.autoTrust ?? false
  }

  /** 检查来源信任状态（SEC-05 TOFU） */
  async checkSourceTrust(ref: SourceRef): Promise<void> {
    const status = this.trustStore.lookup(ref)

    if (status === "blocked") {
      throw new SecurityError(`Source is blocked: ${formatSourceRef(ref)}`)
    }

    if (status === "unknown") {
      if (this.autoTrust) {
        // 非交互模式自动信任
        this.trustStore.remember(ref, "trusted")
        return
      }
      // TOFU: 要求显式确认
      throw new SecurityError(
        `Unknown source: ${formatSourceRef(ref)}. ` +
        `Add to trusted-sources.yaml first or use --trust flag.`
      )
    }
    // status === "trusted" → 通过
  }

  /** 检查调用者权限（SEC-06） */
  async checkCallerPermission(operation: string): Promise<void> {
    const caller = process.env.OCTOPUS_CALLER || "human"
    const adminOps = ["register", "gc", "trust-revoke", "trust-block"]

    if (caller === "agent" && adminOps.includes(operation)) {
      throw new SecurityError(
        `Agent cannot perform '${operation}'. Admin-only operation.`
      )
    }
  }

  /** 检查 Agent 确认标志（SEC-06 修正） */
  async checkAgentConfirmation(operation: string, options: { yes?: boolean; confirmed?: boolean }): Promise<void> {
    const caller = process.env.OCTOPUS_CALLER || "human"

    if (caller === "agent" && options.yes) {
      throw new SecurityError(
        "Agent cannot use --yes. Use --confirmed with OCTOPUS_CALLER=agent instead."
      )
    }

    if (caller === "agent" && !options.confirmed) {
      throw new SecurityError(
        "Agent must use --confirmed flag with OCTOPUS_CALLER=agent environment variable."
      )
    }
  }

  /** 获取 TrustStore 实例 */
  getTrustStore(): TrustStore {
    return this.trustStore
  }

  /** SEC-04: Path traversal check — ensure target is within workspace (ISecurityContext) */
  checkPathTraversal(targetPath: string, wsDir: string): void {
    if (!isPathWithinBase(targetPath, wsDir)) {
      throw new SecurityError(
        `Path traversal detected: ${targetPath} escapes workspace ${wsDir}`
      )
    }
  }
}
