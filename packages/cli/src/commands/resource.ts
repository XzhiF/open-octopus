import { Command } from "commander"
import chalk from "chalk"

const getServerUrl = (): string => process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"

// ── Shared helpers ─────────────────────────────────────────────────

interface ApiListResponse<T> {
  data: T[]
  meta: { total: number; returned: number }
}
interface ApiSingleResponse<T> {
  data: T
}
interface ApiErrorResponse {
  error: { code: string; message: string; hint?: string }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getServerUrl()}${path}`, init)
  const body = await res.json()
  if (!res.ok) {
    const err = body as ApiErrorResponse
    const msg = err.error?.message ?? `HTTP ${res.status}`
    const hint = err.error?.hint ? `\n  ${chalk.dim("Hint:")} ${err.error.hint}` : ""
    throw new Error(`${msg}${hint}`)
  }
  return body as T
}

function printError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(chalk.red(`Error: ${msg}`))
}

// ── Command group ──────────────────────────────────────────────────

export const resourceCmd = new Command("resource")
  .description("Resource management (skills, agents, workflows)")

// ── 1. install <ref...> ────────────────────────────────────────────

resourceCmd
  .command("install <ref...>")
  .description("Install one or more resources by reference")
  .action(async (refs: string[]) => {
    for (const ref of refs) {
      try {
        const res = await apiFetch<ApiSingleResponse<{ name: string; type: string; version: string }>>(
          "/api/resources/install",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ref }),
          },
        )
        const { name, type, version } = res.data
        console.log(chalk.green(`  Installed ${type}/${name} (v${version})`))
      } catch (err) {
        console.error(chalk.red(`  Failed to install '${ref}': ${err instanceof Error ? err.message : String(err)}`))
      }
    }
  })

// ── 2. uninstall <name> --type <type> ──────────────────────────────

resourceCmd
  .command("uninstall <name>")
  .description("Uninstall a resource")
  .requiredOption("--type <type>", "Resource type (skill, agent, workflow)")
  .action(async (name: string, options: { type: string }) => {
    try {
      await apiFetch("/api/resources/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: options.type }),
      })
      console.log(chalk.green(`Uninstalled ${options.type}/${name}`))
    } catch (err) {
      printError(err)
    }
  })

// ── 3. list [--type <type>] [--query <q>] ──────────────────────────

resourceCmd
  .command("list")
  .description("List registered resources")
  .option("--type <type>", "Filter by resource type")
  .option("--query <q>", "Search query")
  .option("--installed", "Show only installed resources")
  .option("--tag <tag>", "Filter by tag")
  .action(async (options: { type?: string; query?: string; installed?: boolean; tag?: string }) => {
    try {
      const params = new URLSearchParams()
      if (options.type) params.set("type", options.type)
      if (options.query) params.set("query", options.query)
      if (options.installed) params.set("installed", "true")
      if (options.tag) params.set("tag", options.tag)

      const qs = params.toString()
      const res = await apiFetch<ApiListResponse<{
        name: string; type: string; version: string; installed: boolean; tags?: string[]
      }>>(`/api/resources${qs ? `?${qs}` : ""}`)

      if (res.data.length === 0) {
        console.log(chalk.yellow("No resources found"))
        return
      }

      console.log(chalk.bold(`Resources (${res.meta.total}):`))
      for (const r of res.data) {
        const status = r.installed ? chalk.green("installed") : chalk.dim("not installed")
        const tags = r.tags?.length ? ` ${chalk.dim(`[${r.tags.join(", ")}]`)}` : ""
        console.log(`  ${chalk.cyan(r.type)}/${r.name}  v${r.version}  ${status}${tags}`)
      }
    } catch (err) {
      printError(err)
    }
  })

// ── 4. info <name> --type <type> ───────────────────────────────────

resourceCmd
  .command("info <name>")
  .description("Show resource details")
  .requiredOption("--type <type>", "Resource type (skill, agent, workflow)")
  .action(async (name: string, options: { type: string }) => {
    try {
      const res = await apiFetch<ApiSingleResponse<{
        name: string; type: string; version: string; installed: boolean;
        installPath?: string; contentHash?: string; dependencies: string[];
        source: { type: string }; tags?: string[];
        createdAt: string; updatedAt: string;
      }>>(`/api/resources/${encodeURIComponent(options.type)}/${encodeURIComponent(name)}`)

      const r = res.data
      console.log(chalk.bold(`${r.type}/${r.name}`))
      console.log(`  Version:      ${r.version}`)
      console.log(`  Installed:    ${r.installed ? chalk.green("yes") : chalk.dim("no")}`)
      if (r.installPath) console.log(`  Path:         ${r.installPath}`)
      if (r.contentHash) console.log(`  Hash:         ${r.contentHash.slice(0, 12)}`)
      if (r.dependencies.length > 0) console.log(`  Dependencies: ${r.dependencies.join(", ")}`)
      if (r.tags?.length) console.log(`  Tags:         ${r.tags.join(", ")}`)
      console.log(`  Source:        ${r.source.type}`)
      console.log(`  Updated:      ${r.updatedAt}`)
    } catch (err) {
      printError(err)
    }
  })

// ── 5. gc [--dry-run] ──────────────────────────────────────────────

resourceCmd
  .command("gc")
  .description("Garbage-collect unreferenced cached resources")
  .option("--dry-run", "Preview what would be removed without deleting")
  .action(async (options: { dryRun?: boolean }) => {
    try {
      const res = await apiFetch<ApiSingleResponse<{
        removed: string[]; freedBytes: number; freedHuman: string
      }>>("/api/resources/gc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: options.dryRun ?? false }),
      })

      const { removed, freedHuman } = res.data
      if (removed.length === 0) {
        console.log(chalk.green("Nothing to clean up"))
        return
      }

      const label = options.dryRun ? "Would remove" : "Removed"
      console.log(chalk.bold(`${label} ${removed.length} item(s) (freed ${freedHuman}):`))
      for (const item of removed) {
        console.log(`  ${chalk.dim("-")} ${item}`)
      }
      if (options.dryRun) {
        console.log(chalk.dim("\nRun without --dry-run to actually remove these items."))
      }
    } catch (err) {
      printError(err)
    }
  })

// ── 6. sync [--fix] [--targets <names...>] ─────────────────────────

resourceCmd
  .command("sync")
  .description("Detect and optionally fix registry drift")
  .option("--fix", "Automatically fix detected drifts")
  .option("--targets <names...>", "Limit sync to specific resources")
  .action(async (options: { fix?: boolean; targets?: string[] }) => {
    try {
      const res = await apiFetch<ApiSingleResponse<{
        drifts: Array<{ resource: string; type: string; issue: string; fixed: boolean }>;
        totalDrifts: number
      }>>("/api/resources/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fix: options.fix ?? false, targets: options.targets }),
      })

      const { drifts, totalDrifts } = res.data
      if (totalDrifts === 0) {
        console.log(chalk.green("No drift detected — registry is consistent"))
        return
      }

      console.log(chalk.bold(`Found ${totalDrifts} drift(s):`))
      for (const d of drifts) {
        const icon = d.fixed ? chalk.green("fixed") : chalk.yellow(d.issue)
        console.log(`  ${icon}  ${d.type}/${d.resource}`)
      }

      if (!options.fix && totalDrifts > 0) {
        console.log(chalk.dim("\nRun with --fix to auto-repair drifts."))
      }
    } catch (err) {
      printError(err)
    }
  })

// ── 7. audit [--last <n>] [--action <action>] [--resource <name>] ──

resourceCmd
  .command("audit")
  .description("Show audit log entries")
  .option("--last <n>", "Show only the last N entries", parseInt)
  .option("--action <action>", "Filter by action (install, uninstall, gc, sync, doctor)")
  .option("--resource <name>", "Filter by resource name")
  .action(async (options: { last?: number; action?: string; resource?: string }) => {
    try {
      const params = new URLSearchParams()
      if (options.last) params.set("last", String(options.last))
      if (options.action) params.set("action", options.action)
      if (options.resource) params.set("resource", options.resource)

      const qs = params.toString()
      const res = await apiFetch<ApiListResponse<{
        timestamp: string; action: string; resource: string; type: string;
        status: string; detail?: string; caller?: string
      }>>(`/api/resources/audit${qs ? `?${qs}` : ""}`)

      if (res.data.length === 0) {
        console.log(chalk.yellow("No audit entries found"))
        return
      }

      console.log(chalk.bold(`Audit log (${res.meta.returned} of ${res.meta.total} entries):`))
      for (const e of res.data) {
        const statusIcon = e.status === "success" ? chalk.green("ok") : chalk.red("fail")
        const caller = e.caller ? chalk.dim(` (${e.caller})`) : ""
        console.log(`  ${chalk.dim(e.timestamp)}  ${e.action}  ${e.type}/${e.resource}  ${statusIcon}${caller}`)
        if (e.detail) console.log(`    ${chalk.dim(e.detail)}`)
      }
    } catch (err) {
      printError(err)
    }
  })

// ── 8. doctor ──────────────────────────────────────────────────────

resourceCmd
  .command("doctor")
  .description("Run health checks on the resource system")
  .action(async () => {
    try {
      const res = await apiFetch<ApiSingleResponse<{
        checks: Array<{ name: string; healthy: boolean; detail?: string }>;
        healthy: boolean
      }>>("/api/resources/doctor")

      const { checks, healthy } = res.data
      const passed = checks.filter(c => c.healthy).length

      if (healthy) {
        console.log(chalk.green(`All ${passed} checks passed`))
      } else {
        const failed = checks.length - passed
        console.log(chalk.red(`${failed} check(s) failed, ${passed} passed`))
      }

      for (const check of checks) {
        const icon = check.healthy ? chalk.green("PASS") : chalk.red("FAIL")
        console.log(`  ${icon}  ${check.name}`)
        if (check.detail) console.log(`         ${chalk.dim(check.detail)}`)
      }
    } catch (err) {
      printError(err)
    }
  })
