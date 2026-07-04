/**
 * OutputFormatter — 双消费者输出格式化
 *
 * 支持三种输出模式:
 *   - Rich: 彩色终端输出（默认）
 *   - JSON: 结构化 JSON（--json 标志）
 *   - Quiet: 仅输出关键值（--quiet 标志）
 *
 * 人类消费者看到彩色表格，Agent 消费者获得可解析 JSON。
 */
import chalk from "chalk"
import type {
  RegistryEntry,
  ResourceType,
} from "@octopus/shared"
import type { InstallPlan, InstallResult } from "./installer"

export interface OutputOptions {
  json?: boolean
  quiet?: boolean
  noColor?: boolean
  format?: "rich" | "plain"
}

export class OutputFormatter {
  private opts: OutputOptions

  constructor(opts: OutputOptions = {}) {
    this.opts = opts
  }

  // --- Helpers ---

  private c(color: string, text: string): string {
    if (this.opts.noColor) return text
    return (chalk as any)[color]?.(text) ?? text
  }

  private dim(text: string): string { return this.c("dim", text) }
  private green(text: string): string { return this.c("green", text) }
  private red(text: string): string { return this.c("red", text) }
  private yellow(text: string): string { return this.c("yellow", text) }
  private blue(text: string): string { return this.c("blue", text) }
  private bold(text: string): string { return this.c("bold", text) }

  private typeColor(type: ResourceType): string {
    const colors: Record<ResourceType, string> = {
      skill: "magenta",
      agent: "green",
      workflow: "blue",
      source: "yellow",
    }
    return colors[type] || "white"
  }

  // --- Command outputs ---

  initSuccess(repoPath: string): string {
    if (this.opts.json) return JSON.stringify({ status: "initialized", path: repoPath, created_dirs: ["manifests", "cache"] })
    if (this.opts.quiet) return ""
    return `${this.green("✓")} Repository initialized at ${repoPath}\n\n  ${repoPath}/\n  ├── registry.json\n  ├── trusted-sources.yaml\n  ├── manifests/\n  └── cache/`
  }

  registerSuccess(entry: RegistryEntry): string {
    if (this.opts.json) return JSON.stringify({ registered: entry })
    if (this.opts.quiet) return entry.name
    return [
      `${this.green("✓")} Registered: ${this.bold(entry.name)}`,
      `  Type:         ${this.c(this.typeColor(entry.type), entry.type)}`,
      `  Version:      ${entry.version}`,
      `  Source:       ${this.formatSource(entry.source)}`,
      `  Dependencies: ${entry.dependencies.length}`,
      `  Hash:         ${this.dim(entry.hash)}`,
      `  Size:         ${this.formatSize(entry.size ?? 0)}`,
    ].join("\n")
  }

  listResources(entries: RegistryEntry[]): string {
    if (this.opts.json) {
      const grouped: Record<string, RegistryEntry[]> = { skills: [], agents: [], workflows: [], sources: [] }
      for (const e of entries) {
        const key = (e.type + "s") as keyof typeof grouped
        grouped[key]?.push(e)
      }
      return JSON.stringify(grouped)
    }
    if (this.opts.quiet) return entries.map(e => e.name).join("\n")
    if (entries.length === 0) return this.emptyState("No resources registered", "octopus repo register <ref> --type <type>")

    const grouped = new Map<ResourceType, RegistryEntry[]>()
    for (const e of entries) {
      const list = grouped.get(e.type) ?? []
      list.push(e)
      grouped.set(e.type, list)
    }

    const lines: string[] = []
    for (const [type, items] of grouped) {
      lines.push(`  ${this.bold(`${type}s`)} (${items.length}):`)
      lines.push(`    ${"Name".padEnd(30)} ${"Version".padEnd(10)} ${"Deps".padEnd(6)} Source`)
      lines.push(`    ${"─".repeat(28)}  ${"─".repeat(8)}  ${"─".repeat(4)}  ${"─".repeat(16)}`)
      for (const item of items) {
        const source = this.formatSource(item.source)
        lines.push(`    ${item.name.padEnd(30)} ${item.version.padEnd(10)} ${String(item.dependencies.length).padEnd(6)} ${source}`)
      }
      lines.push("")
    }
    const total = entries.length
    const typeCounts = Array.from(grouped.entries()).map(([t, items]) => `${items.length} ${t}s`).join(", ")
    lines.push(`  Total: ${total} resources (${typeCounts}).`)
    return lines.join("\n")
  }

  searchResults(results: RegistryEntry[], total: number, page: number, perPage: number): string {
    if (this.opts.json) return JSON.stringify({ results, total, page, per_page: perPage })
    if (this.opts.quiet) return results.map(e => e.name).join("\n")
    if (results.length === 0) return this.emptyState("No matching resources found", "octopus repo search --type skill")

    const lines: string[] = []
    lines.push(`  ${"Name".padEnd(30)} ${"Type".padEnd(10)} ${"Version".padEnd(10)} ${"Deps".padEnd(6)} Source`)
    lines.push(`  ${"─".repeat(28)}  ${"─".repeat(8)}  ${"─".repeat(8)}  ${"─".repeat(4)}  ${"─".repeat(16)}`)
    for (const item of results) {
      lines.push(`  ${item.name.padEnd(30)} ${this.c(this.typeColor(item.type), item.type.padEnd(10))} ${item.version.padEnd(10)} ${String(item.dependencies.length).padEnd(6)} ${this.formatSource(item.source)}`)
    }
    lines.push(`\n  ${total} results total.`)
    if (total > page * perPage) {
      lines.push(`  ${this.dim(`Use --page ${page + 1} to see more`)}`)
    }
    return lines.join("\n")
  }

  resourceInfo(entry: RegistryEntry): string {
    if (this.opts.json) return JSON.stringify({ manifest: entry })
    if (this.opts.quiet) return `${entry.name} ${entry.version}`
    return [
      `  ${this.bold(entry.name)} [${this.c(this.typeColor(entry.type), entry.type)}] v${entry.version}`,
      `  ${"─".repeat(40)}`,
      `  Description:  ${entry.description || this.dim("(no description)")}`,
      `  Source:       ${this.formatSource(entry.source)}`,
      `  Dependencies: ${entry.dependencies.length}`,
      `  Tags:         ${entry.tags.length > 0 ? entry.tags.join(", ") : this.dim("(no tags)")}`,
      `  Hash:         ${this.dim(entry.hash)}`,
      `  Size:         ${this.formatSize(entry.size ?? 0)}`,
      `  Registered:   ${this.dim(entry.registered_at)}`,
    ].join("\n")
  }

  installPlan(plan: InstallPlan): string {
    if (this.opts.json) {
      return JSON.stringify({
        plan: {
          ordered: plan.ordered.map(s => ({ name: s.name, type: s.type })),
        },
      })
    }
    if (this.opts.quiet) return String(plan.ordered.length)

    const lines: string[] = ["  Install Plan:"]
    for (const step of plan.ordered) {
      lines.push(`  ${this.green("+")} ${step.type}:${step.name.padEnd(30)} will install`)
    }
    lines.push(`\n  ${plan.ordered.length} to install.`)
    return lines.join("\n")
  }

  installProgress(
    step: number,
    total: number,
    name: string,
    status: "success" | "failed" | "pending" | "installing",
    detail: string,
  ): string {
    const icons = {
      success: this.green("✓"),
      failed: this.red("✗"),
      pending: this.dim("·"),
      installing: this.yellow("⏳"),
    }
    const icon = icons[status]
    return `  [${step}/${total}] ${icon} ${name.padEnd(30)} ${detail}`
  }

  installSummary(
    installed: { name: string; target: string }[],
    failed: { name: string; reason: string }[],
    skipped: { name: string; reason: string }[],
  ): string {
    const total = installed.length + failed.length + skipped.length
    if (this.opts.json) {
      return JSON.stringify({
        installed,
        failed,
        skipped,
        status: failed.length === 0 ? "success" : "partial",
      })
    }
    if (this.opts.quiet) return `${installed.length}/${total}`

    const lines: string[] = []
    if (failed.length === 0 && skipped.length === 0) {
      lines.push(`\n  ${this.green("✓")} Install complete: ${installed.length}/${total} succeeded`)
    } else {
      lines.push(`\n  Install complete: ${installed.length}/${total} succeeded, ${failed.length} failed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`)
      if (failed.length > 0) {
        lines.push(`\n  Failed:`)
        for (const f of failed) {
          lines.push(`    ${this.red("·")} ${f.name}: ${f.reason}`)
        }
      }
      if (skipped.length > 0) {
        lines.push(`\n  Skipped:`)
        for (const s of skipped) {
          lines.push(`    ${this.dim("·")} ${s.name}: ${s.reason}`)
        }
      }
    }
    lines.push(`  Lock file generated: .octopus/resources.lock`)
    return lines.join("\n")
  }

  error(code: string, message: string, fix: string): string {
    if (this.opts.json) return JSON.stringify({ error: { code, message, details: { fix } } })
    return `${this.red("[ERROR]")} ${code}: ${message}\n\n  Fix: ${fix}`
  }

  emptyState(description: string, suggestion: string): string {
    if (this.opts.json) return JSON.stringify({ results: [], message: description })
    return `  ${this.dim("·")} ${description}\n\n  Try:\n  · ${suggestion}`
  }

  // --- Formatting helpers ---

  private formatSource(source: any): string {
    if (!source) return "unknown"
    switch (source.protocol) {
      case "npm": return `npm:${source.package}`
      case "github": return `github:${source.repo}`
      case "local": return `local:${source.path}`
      case "builtin": return `builtin:${source.id}`
      default: return "unknown"
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
}
