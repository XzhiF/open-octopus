/**
 * resource audit — 查询审计日志
 *
 * 支持按 action / resource / caller / since 过滤
 */
import { Command } from "commander"
import { join } from "path"
import {
  AuditLogger,
  ResourceError,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

export function auditCommand(): Command {
  return new Command("audit")
    .description("Query resource audit log")
    .option("--action <action>", "Filter by action (e.g. resource.registered)")
    .option("--resource <name>", "Filter by resource name")
    .option("--caller <caller>", "Filter by caller: human, agent")
    .option("--since <date>", "Filter entries after this ISO date")
    .option("--limit <n>", "Maximum entries to show", "50")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: {
      action?: string; resource?: string; caller?: string
      since?: string; limit: string; org?: string; format: string
    }) => {
      const fmt = new OutputFormatter(opts.format as "rich" | "json" | "quiet")
      try {
        const org = opts.org || resolveCurrentOrg()
        const orgDir = resolveOrgDir(org)
        const auditDir = join(orgDir, "resources", "audit")

        const auditLogger = new AuditLogger(auditDir)
        const entries = auditLogger.query({
          action: opts.action,
          resource: opts.resource,
          caller: opts.caller as "human" | "agent" | undefined,
          since: opts.since,
          limit: parseInt(opts.limit, 10) || 50,
        })

        if (entries.length === 0) {
          console.log(fmt.error("No audit entries found", "Audit log is empty or filters match nothing"))
          return
        }

        const rows = entries.map(e => ({
          timestamp: e.timestamp,
          action: e.action,
          resource: e.resource,
          caller: e.caller,
        }))

        console.log(fmt.table(rows))
      } catch (err: unknown) {
        if (err instanceof ResourceError) {
          process.exitCode = ResourceError.toExitCode(err.code as any)
          console.error(fmt.error(err.message, err.suggestion))
        } else {
          process.exitCode = 1
          console.error(fmt.error(err instanceof Error ? err.message : String(err)))
        }
      }
    })
}
