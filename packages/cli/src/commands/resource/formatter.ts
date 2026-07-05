/**
 * OutputFormatter — 三种输出模式（rich / json / quiet）
 *
 * rich:  带 Unicode 符号和对齐表格的终端友好输出
 * json:  机器可读的 JSON
 * quiet: 仅输出名称，适合管道串联
 */

export type OutputMode = "rich" | "json" | "quiet"

export class OutputFormatter {
  constructor(private mode: OutputMode = "rich") {}

  /**
   * 格式化表格数据
   */
  table(rows: Record<string, any>[]): string {
    if (this.mode === "json") return JSON.stringify(rows, null, 2)
    if (this.mode === "quiet") return rows.map(r => r.name ?? "").join("\n")
    if (rows.length === 0) return "  (empty)"

    const keys = Object.keys(rows[0])
    const widths = keys.map(k =>
      Math.max(k.length, ...rows.map(r => String(r[k] ?? "").length)),
    )
    const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ")
    const separator = widths.map(w => "─".repeat(w)).join("  ")
    const body = rows.map(r =>
      keys.map((k, i) => String(r[k] ?? "").padEnd(widths[i])).join("  "),
    )
    return [header, separator, ...body].join("\n")
  }

  /**
   * 格式化成功消息
   */
  success(msg: string): string {
    if (this.mode === "json") return JSON.stringify({ success: true, message: msg })
    if (this.mode === "quiet") return msg
    return `✓ ${msg}`
  }

  /**
   * 格式化错误消息（可选建议）
   */
  error(msg: string, suggestion?: string): string {
    if (this.mode === "json") return JSON.stringify({ error: msg, suggestion })
    const base = `✗ ${msg}`
    return suggestion ? `${base}\n  \u{1F4A1} ${suggestion}` : base
  }

  /**
   * 格式化信息（key-value 详情卡片）
   */
  detail(fields: Record<string, string | number | boolean | undefined>): string {
    if (this.mode === "json") return JSON.stringify(fields, null, 2)
    if (this.mode === "quiet") return JSON.stringify(fields)

    const keys = Object.keys(fields).filter(k => fields[k] !== undefined)
    if (keys.length === 0) return "  (empty)"
    const maxKey = Math.max(...keys.map(k => k.length))
    return keys.map(k => `  ${k.padEnd(maxKey)}  ${fields[k]}`).join("\n")
  }

  /**
   * 树状缩进输出
   */
  tree(lines: string[]): string {
    if (this.mode === "json") return JSON.stringify(lines)
    return lines.map(l => `  ${l}`).join("\n")
  }
}
