import { Command } from "commander"
import chalk from "chalk"

function resolveServerUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

interface ApiError {
  error: { code: string; message: string; suggestion?: string }
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${resolveServerUrl()}/api/resources${path}`
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
    const result = await apiRequest<{ name: string; type: string; source: string }>(
      "POST", "/install", { ref, scope: options.scope ?? "org" },
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
    await apiRequest("POST", "/uninstall", { name, type: options.type })
    console.log(chalk.green(`✓ Uninstalled ${name} (${options.type})`))
  })

// --- list ---
resourceCmd
  .command("list")
  .description("列出已安装资源")
  .option("--type <type>", "按类型过滤 (skill/agent/workflow)")
  .option("--query <q>", "按名称搜索")
  .action(async (options: { type?: string; query?: string }) => {
    let path = ""
    const params = new URLSearchParams()
    if (options.type) params.set("type", options.type)
    if (options.query) params.set("query", options.query)
    const qs = params.toString()
    if (qs) path += `?${qs}`

    const data = await apiRequest<{
      resources: Array<{ name: string; type: string; source: string; status: string; installedAt?: string }>
    }>("GET", path)

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
    const types = options.type ? [options.type] : ["skill", "agent", "workflow"]
    let detail: { name: string; type: string; source: string; status: string; installedAt?: string; installPath?: string; dependsOn?: string[] } | undefined

    for (const t of types) {
      try {
        detail = await apiRequest<typeof detail>(`GET`, `/${t}/${encodeURIComponent(name)}`)
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
    if (detail.dependsOn?.length) console.log(chalk.bold(`Dependencies:`) + detail.dependsOn.join(", "))
  })

// --- audit ---
resourceCmd
  .command("audit")
  .description("查看审计日志")
  .option("--last <n>", "最近 N 条记录", "20")
  .option("--action <action>", "按操作过滤 (install/uninstall/verify)")
  .action(async (options: { last: string; action?: string }) => {
    const params = new URLSearchParams({ last: options.last })
    if (options.action) params.set("action", options.action)

    const data = await apiRequest<{
      records: Array<{ timestamp: string; action: string; resource_name: string; resource_type: string; source: string; caller: string }>
    }>("GET", `/audit?${params}`)

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
    const data = await apiRequest<{
      resources: Array<{ name: string; type: string; description?: string; installed: boolean }>
    }>("GET", "/builtin")

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
    const data = await apiRequest<{
      total: number; byType: Record<string, number>; byStatus: Record<string, number>; bySource: Record<string, number>
    }>("GET", "/stats")

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

// ── source subcommand group ─────────────────────────────────────────────────

const sourceCmd = resourceCmd
  .command("source")
  .description("管理集合源 (git repositories)")

// --- source add ---
sourceCmd
  .command("add")
  .description("添加集合源 (git clone + discover)")
  .argument("<url>", "Git URL (https://github.com/...)")
  .option("--name <name>", "自定义源名称")
  .option("--branch <branch>", "Git branch", "main")
  .action(async (url: string, options: { name?: string; branch: string }) => {
    const result = await apiRequest<{
      name: string; url: string
      resourceCount: { skills: number; agents: number; workflows: number }
    }>("POST", "/source/add", { url, name: options.name, branch: options.branch })

    console.log(chalk.green(`✓ Added source: ${result.name}`))
    console.log(chalk.dim(`  URL: ${result.url}`))
    const { skills, agents, workflows } = result.resourceCount
    console.log(chalk.dim(`  Resources: ${skills} skills, ${agents} agents, ${workflows} workflows`))
    console.log(chalk.dim(`  Install: octopus resource install git:${result.name}/<resource-path>`))
  })

// --- source list ---
sourceCmd
  .command("list")
  .description("列出已添加的集合源")
  .action(async () => {
    const data = await apiRequest<{
      sources: Array<{ name: string; url: string; resourceCount: { skills: number; agents: number; workflows: number }; lastUpdated: string; trusted: boolean }>
    }>("GET", "/source/list")

    if (!data.sources?.length) {
      console.log("No sources added.")
      return
    }

    const cols = { name: 24, url: 50, resources: 20, updated: 20, trusted: 8 }
    console.log(
      chalk.dim(
        `${pad("NAME", cols.name)}${pad("URL", cols.url)}${pad("RESOURCES", cols.resources)}${pad("UPDATED", cols.updated)}${pad("TRUSTED", cols.trusted)}`,
      ),
    )
    for (const s of data.sources) {
      const r = `${s.resourceCount.agents}a ${s.resourceCount.skills}s`
      const t = s.trusted ? chalk.green("yes") : chalk.red("no")
      console.log(
        `${pad(s.name, cols.name)}${pad(s.url, cols.url)}${pad(r, cols.resources)}${pad(formatDate(s.lastUpdated), cols.updated)}${pad(t, cols.trusted)}`,
      )
    }
  })

// --- source update ---
sourceCmd
  .command("update")
  .description("更新集合源 (git pull + re-discover)")
  .argument("<name>", "源名称")
  .action(async (name: string) => {
    const result = await apiRequest<{
      name: string; resourceCount: { skills: number; agents: number; workflows: number }
    }>("POST", "/source/update", { name })

    console.log(chalk.green(`✓ Updated: ${result.name}`))
    const { skills, agents, workflows } = result.resourceCount
    console.log(chalk.dim(`  ${skills} skills, ${agents} agents, ${workflows} workflows`))
  })

// --- source remove ---
sourceCmd
  .command("remove")
  .description("移除集合源")
  .argument("<name>", "源名称")
  .action(async (name: string) => {
    await apiRequest("DELETE", `/source/${encodeURIComponent(name)}`)
    console.log(chalk.green(`✓ Removed: ${name}`))
    console.log(chalk.yellow("  Note: Already installed resources remain installed."))
  })

// --- source analyze ---
sourceCmd
  .command("analyze")
  .description("预览集合源资源 (不安装)")
  .argument("<url>", "Git URL")
  .action(async (url: string) => {
    const data = await apiRequest<{
      resources: Array<{ name: string; type: string; path: string }>
    }>("POST", "/source/analyze", { url })

    if (!data.resources?.length) {
      console.log("No resources discovered.")
      return
    }

    console.log(chalk.bold(`Discovered ${data.resources.length} resource(s):`))
    const cols = { name: 30, type: 10, path: 50 }
    console.log(
      chalk.dim(`${pad("NAME", cols.name)}${pad("TYPE", cols.type)}${pad("PATH", cols.path)}`),
    )
    for (const r of data.resources) {
      console.log(`${pad(r.name, cols.name)}${pad(r.type, cols.type)}${pad(r.path, cols.path)}`)
    }
  })

// --- source info ---
sourceCmd
  .command("info")
  .description("查看集合源详情")
  .argument("<name>", "源名称")
  .action(async (name: string) => {
    const s = await apiRequest<{
      name: string; url: string; branch: string; addedAt: string; lastUpdated: string
      cachePath: string; trusted: boolean
      resourceCount: { skills: number; agents: number; workflows: number }
    }>("GET", `/source/${encodeURIComponent(name)}`)

    console.log(chalk.bold("Name:         ") + s.name)
    console.log(chalk.bold("URL:          ") + s.url)
    console.log(chalk.bold("Branch:       ") + s.branch)
    console.log(chalk.bold("Added:        ") + formatDate(s.addedAt))
    console.log(chalk.bold("Updated:      ") + formatDate(s.lastUpdated))
    console.log(chalk.bold("Cache:        ") + s.cachePath)
    console.log(chalk.bold("Trusted:      ") + (s.trusted ? chalk.green("yes") : chalk.red("no")))
    console.log(chalk.bold("Skills:       ") + s.resourceCount.skills)
    console.log(chalk.bold("Agents:       ") + s.resourceCount.agents)
    console.log(chalk.bold("Workflows:    ") + s.resourceCount.workflows)
  })

// --- source install ---
sourceCmd
  .command("install")
  .description("从集合源批量安装资源")
  .argument("<source>", "源名称 (如 agency-agents-zh)")
  .option("--group <group>", "安装到指定组 (默认=源名称)")
  .option("--all", "安装源中所有资源", false)
  .action(async (source: string, options: { group?: string; all: boolean }) => {
    if (!options.all) {
      console.log(chalk.yellow("请指定 --all 安装所有资源:"))
      console.log(chalk.dim(`  octopus resource source install ${source} --all`))
      return
    }

    const result = await apiRequest<{ installed: number; skipped: number }>(
      "POST", "/source/install",
      { sourceName: source, group: options.group, all: true },
    )
    console.log(chalk.green(`✓ Installed ${result.installed} resource(s) from ${source}`))
    if (result.skipped > 0) {
      console.log(chalk.dim(`  Skipped ${result.skipped} already installed`))
    }
  })

// --- source sync ---
sourceCmd
  .command("sync")
  .description("同步集合源 — 更新已安装资源，检测新增/删除")
  .argument("<name>", "源名称")
  .action(async (name: string) => {
    const result = await apiRequest<{
      sourceName: string; updated: number; added: number; removed: number; unchanged: number
    }>("POST", "/source/sync", { sourceName: name })

    console.log(chalk.green(`✓ Synced: ${result.sourceName}`))
    console.log(chalk.dim(`  Updated: ${result.updated}`))
    console.log(chalk.dim(`  New:     ${result.added} (not installed)`))
    console.log(chalk.dim(`  Removed: ${result.removed} (marked orphan)`))
    console.log(chalk.dim(`  Unchanged: ${result.unchanged}`))

    if (result.added > 0) {
      console.log(chalk.yellow(`\n  ${result.added} new resource(s) available. Install with:`))
      console.log(chalk.dim(`  octopus resource source install ${name} --all`))
    }
  })
