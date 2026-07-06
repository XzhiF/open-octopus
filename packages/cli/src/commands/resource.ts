import { Command } from "commander"
import chalk from "chalk"
import { resolveCurrentOrg } from "../utils/path"

function resolveServerUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

interface ApiError {
  error: { code: string; message: string; suggestion?: string }
}

async function apiRequest<T>(
  method: string,
  path: string,
  org: string,
  body?: unknown,
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?"
  const url = `${resolveServerUrl()}/api/resources${path}${sep}org=${encodeURIComponent(org)}`
  const headers: Record<string, string> = {}
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    console.error(chalk.red("Cannot connect to Server") + ` at ${resolveServerUrl()}`)
    console.error("Make sure the server is running: " + chalk.cyan("pnpm dev"))
    process.exit(1)
    throw new Error("unreachable") // safety: process.exit may be mocked in tests
  }

  if (!res.ok) {
    let errBody: ApiError | undefined
    try {
      errBody = await res.json() as ApiError
    } catch { /* non-JSON error */ }

    if (errBody?.error) {
      const { code, message, suggestion } = errBody.error
      console.error(chalk.red(`Error [${code}]: ${message}`))
      if (suggestion) console.error(chalk.yellow(`Hint: ${suggestion}`))
    } else {
      console.error(chalk.red(`HTTP ${res.status}: ${res.statusText}`))
    }
    process.exit(1)
    throw new Error("unreachable") // safety: process.exit may be mocked in tests
  }

  return res.json() as Promise<T>
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  } catch {
    return iso
  }
}

export const resourceCmd = new Command("resource")
  .description("统一资源管理 (skill/agent/workflow)")
  .option("--org <org>", "组织名")

// --- install ---
resourceCmd
  .command("install")
  .description("安装资源 (builtin:xxx 或 local:path)")
  .argument("<ref>", "资源引用 (如 builtin:brainstorming)")
  .option("--scope <scope>", "安装范围 (org)")
  .action(async (ref: string, options: { scope?: string }) => {
    const org = resolveCurrentOrg()
    const result = await apiRequest<{ name: string; type: string; source: string }>(
      "POST", "/install", org, { ref, scope: options.scope ?? "org" },
    )
    console.log(
      chalk.green(`✓ Installed ${result.name} (${result.type}) from ${result.source}`),
    )
    console.log(
      chalk.dim(`  View in UI: ${resolveServerUrl()}/resources`),
    )
  })

// --- uninstall ---
resourceCmd
  .command("uninstall")
  .description("卸载资源")
  .argument("<name>", "资源名称")
  .requiredOption("--type <type>", "资源类型 (skill/agent/workflow)")
  .action(async (name: string, options: { type: string }) => {
    const org = resolveCurrentOrg()
    await apiRequest("POST", "/uninstall", org, { name, type: options.type })
    console.log(chalk.green(`✓ Uninstalled ${name} (${options.type})`))
  })

// --- list ---
resourceCmd
  .command("list")
  .description("列出已安装资源")
  .option("--type <type>", "按类型过滤 (skill/agent/workflow)")
  .option("--query <q>", "按名称搜索")
  .action(async (options: { type?: string; query?: string }) => {
    const org = resolveCurrentOrg()
    let path = ""
    const params = new URLSearchParams()
    if (options.type) params.set("type", options.type)
    if (options.query) params.set("query", options.query)
    const qs = params.toString()
    if (qs) path += `?${qs}`

    const data = await apiRequest<{
      resources: Array<{ name: string; type: string; source: string; status: string; installedAt?: string }>
    }>("GET", path, org)

    if (!data.resources?.length) {
      console.log("No resources found.")
      return
    }

    const cols = { name: 24, type: 10, source: 14, status: 18, time: 20 }
    console.log(
      chalk.dim(
        `${pad("NAME", cols.name)}${pad("TYPE", cols.type)}${pad("SOURCE", cols.source)}${pad("STATUS", cols.status)}${pad("INSTALLED", cols.time)}`,
      ),
    )
    for (const r of data.resources) {
      console.log(
        `${pad(r.name, cols.name)}${pad(r.type, cols.type)}${pad(r.source, cols.source)}${pad(r.status, cols.status)}${pad(r.installedAt ? formatDate(r.installedAt) : "-", cols.time)}`,
      )
    }
  })

// --- info ---
resourceCmd
  .command("info")
  .description("查看资源详情")
  .argument("<name>", "资源名称")
  .option("--type <type>", "资源类型 (可选，自动检测)")
  .action(async (name: string, options: { type?: string }) => {
    const org = resolveCurrentOrg()
    // If type not given, try common types
    const types = options.type ? [options.type] : ["skill", "agent", "workflow"]
    let detail: { name: string; type: string; source: string; status: string; installedAt?: string; installPath?: string; dependencies?: string[]; metadata?: Record<string, unknown> } | undefined

    for (const t of types) {
      try {
        detail = await apiRequest<typeof detail>(`GET`, `/${t}/${encodeURIComponent(name)}`, org)
        if (detail) break
      } catch {
        // try next type
      }
    }

    if (!detail) {
      console.error(chalk.red(`Resource "${name}" not found.`))
      process.exit(1)
    }

    console.log(chalk.bold(`Name:        `) + detail.name)
    console.log(chalk.bold(`Type:        `) + detail.type)
    console.log(chalk.bold(`Source:      `) + detail.source)
    console.log(chalk.bold(`Status:      `) + detail.status)
    if (detail.installPath) console.log(chalk.bold(`Install Path:`) + detail.installPath)
    if (detail.installedAt) console.log(chalk.bold(`Installed At:`) + formatDate(detail.installedAt))
    if (detail.dependencies?.length) console.log(chalk.bold(`Dependencies:`) + detail.dependencies.join(", "))
    if (detail.metadata && Object.keys(detail.metadata).length > 0) {
      console.log(chalk.bold(`Metadata:`))
      for (const [k, v] of Object.entries(detail.metadata)) {
        console.log(`  ${k}: ${v}`)
      }
    }
  })

// --- audit ---
resourceCmd
  .command("audit")
  .description("查看审计日志")
  .option("--last <n>", "最近 N 条记录", "20")
  .option("--action <action>", "按操作过滤 (install/uninstall/verify)")
  .action(async (options: { last: string; action?: string }) => {
    const org = resolveCurrentOrg()
    const params = new URLSearchParams({ last: options.last })
    if (options.action) params.set("action", options.action)

    const data = await apiRequest<{
      records: Array<{ timestamp: string; action: string; resource_name: string; resource_type: string; source: string; caller: string }>
    }>("GET", `/audit?${params}`, org)

    if (!data.records?.length) {
      console.log("No audit records found.")
      return
    }

    const cols = { time: 20, action: 12, name: 20, type: 10, source: 10, caller: 6 }
    console.log(
      chalk.dim(
        `${pad("TIME", cols.time)}${pad("ACTION", cols.action)}${pad("NAME", cols.name)}${pad("TYPE", cols.type)}${pad("SOURCE", cols.source)}${pad("CALLER", cols.caller)}`,
      ),
    )
    for (const r of data.records) {
      console.log(
        `${pad(formatDate(r.timestamp), cols.time)}${pad(r.action, cols.action)}${pad(r.resource_name, cols.name)}${pad(r.resource_type, cols.type)}${pad(r.source, cols.source)}${pad(r.caller, cols.caller)}`,
      )
    }
  })

// --- search ---
resourceCmd
  .command("search")
  .description("搜索可安装的 builtin 资源")
  .argument("<query>", "搜索关键词 (匹配名称/描述)")
  .option("--type <type>", "按类型过滤 (skill/agent/workflow)")
  .action(async (query: string, options: { type?: string }) => {
    const org = resolveCurrentOrg()
    const data = await apiRequest<{
      resources: Array<{ name: string; type: string; description?: string; installed: boolean }>
    }>("GET", "/builtin", org)

    const q = query.toLowerCase()
    let results = data.resources.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q),
    )
    if (options.type) {
      results = results.filter(r => r.type === options.type)
    }

    if (!results.length) {
      console.log(`No builtin resources matching "${query}".`)
      return
    }

    const cols = { name: 28, type: 10, status: 12, desc: 40 }
    console.log(
      chalk.dim(
        `${pad("NAME", cols.name)}${pad("TYPE", cols.type)}${pad("STATUS", cols.status)}${pad("DESCRIPTION", cols.desc)}`,
      ),
    )
    for (const r of results) {
      const status = r.installed ? chalk.green("installed") : chalk.dim("available")
      const desc = (r.description ?? "-").slice(0, cols.desc)
      console.log(
        `${pad(r.name, cols.name)}${pad(r.type, cols.type)}${pad(status, cols.status)}${pad(desc, cols.desc)}`,
      )
    }
    console.log()
    console.log(chalk.dim(`Found ${results.length} result(s). Install with: octopus resource install builtin:${results[0].name}`))
  })

// --- stats ---
resourceCmd
  .command("stats")
  .description("查看资源统计")
  .action(async () => {
    const org = resolveCurrentOrg()
    const data = await apiRequest<{
      total: number; byType: Record<string, number>; byStatus: Record<string, number>; bySource: Record<string, number>
    }>("GET", "/stats", org)

    console.log(chalk.bold(`Total resources: ${data.total}`))
    console.log()
    if (data.byType) {
      console.log(chalk.bold("By type:"))
      for (const [k, v] of Object.entries(data.byType)) console.log(`  ${k}: ${v}`)
    }
    if (data.byStatus) {
      console.log(chalk.bold("By status:"))
      for (const [k, v] of Object.entries(data.byStatus)) console.log(`  ${k}: ${v}`)
    }
    if (data.bySource) {
      console.log(chalk.bold("By source:"))
      for (const [k, v] of Object.entries(data.bySource)) console.log(`  ${k}: ${v}`)
    }
  })
