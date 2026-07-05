/**
 * resource doctor — 健康检查
 *
 * 检查资源子系统完整性：
 * 1. registry.json 是否可读
 * 2. 所有 registry entry 的 manifest 是否合法
 * 3. trust store 状态
 * 4. 审计日志是否可写
 * 5. 缓存目录是否存在
 */
import { Command } from "commander"
import { join } from "path"
import { existsSync, statSync, writeFileSync, unlinkSync } from "fs"
import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
  ResourceError,
  ResourceManifestSchema,
} from "@octopus/shared"
import { resolveOrgDir, resolveCurrentOrg } from "../../utils/path"
import { OutputFormatter } from "./formatter"

interface CheckResult {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Run health checks on the resource subsystem")
    .option("--fix", "Attempt to repair issues automatically")
    .option("--org <org>", "Organization name")
    .option("--format <mode>", "Output format: rich, json, quiet", "rich")
    .action(async (opts: { fix?: boolean; org?: string; format: string }) => {
      const fmt = new OutputFormatter(opts.format as "rich" | "json" | "quiet")
      try {
        const org = opts.org || resolveCurrentOrg()
        const orgDir = resolveOrgDir(org)
        const resourceDir = join(orgDir, "resources")
        const cacheDir = join(orgDir, "cache", "resources")

        const checks: CheckResult[] = []

        // 1. Registry readable
        const registryPath = join(resourceDir, "registry.json")
        if (!existsSync(registryPath)) {
          checks.push({
            name: "registry.json",
            status: "fail",
            detail: "Not found — run 'octopus resource init'",
          })
        } else {
          try {
            const store = new FsResourceStore(resourceDir)
            const data = await store.atomicStore.read("registry.json")
            if (!data || !data.entries) {
              checks.push({
                name: "registry.json",
                status: "warn",
                detail: "Exists but missing entries field",
              })
            } else {
              checks.push({
                name: "registry.json",
                status: "ok",
                detail: `${Object.keys(data.entries).length} entries`,
              })
            }
          } catch (err: unknown) {
            checks.push({
              name: "registry.json",
              status: "fail",
              detail: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }

        // 2. Manifest validation
        if (existsSync(registryPath)) {
          try {
            const store = new FsResourceStore(resourceDir)
            const data = await store.atomicStore.read("registry.json")
            if (data?.entries) {
              let valid = 0
              let invalid = 0
              for (const [key, entry] of Object.entries(data.entries)) {
                try {
                  ResourceManifestSchema.parse((entry as any).manifest)
                  valid++
                } catch {
                  invalid++
                }
              }
              checks.push({
                name: "manifest-validation",
                status: invalid > 0 ? "warn" : "ok",
                detail: invalid > 0 ? `${valid} valid, ${invalid} invalid` : `All ${valid} manifests valid`,
              })
            }
          } catch {
            // Already reported in check 1
          }
        }

        // 3. Trust store
        const trustStore = new TrustStore()
        const trustData = trustStore.getData()
        checks.push({
          name: "trust-store",
          status: "ok",
          detail: `${trustData.trusted.length} trusted, ${trustData.blocked.length} blocked`,
        })

        // 4. Audit log writable
        const auditDir = join(resourceDir, "audit")
        try {
          const testFile = join(auditDir, ".healthcheck")
          writeFileSync(testFile, "test", "utf-8")
          unlinkSync(testFile)
          checks.push({
            name: "audit-log",
            status: "ok",
            detail: "Writable",
          })
        } catch {
          checks.push({
            name: "audit-log",
            status: existsSync(auditDir) ? "warn" : "fail",
            detail: existsSync(auditDir) ? "Not writable" : "Directory missing",
          })
        }

        // 5. Cache directory
        checks.push({
          name: "cache-dir",
          status: existsSync(cacheDir) ? "ok" : "warn",
          detail: existsSync(cacheDir) ? "Exists" : "Missing (will be created on first install)",
        })

        // 6. Manifest directories
        const manifestDir = join(resourceDir, "manifests")
        for (const type of ["skill", "agent", "workflow", "source"]) {
          const dir = join(manifestDir, type)
          checks.push({
            name: `manifests/${type}`,
            status: existsSync(dir) ? "ok" : "warn",
            detail: existsSync(dir) ? "Exists" : "Missing",
          })
        }

        // Output results
        const rows = checks.map(c => ({
          check: c.name,
          status: c.status === "ok" ? "OK" : c.status === "warn" ? "WARN" : "FAIL",
          detail: c.detail,
        }))
        console.log(fmt.table(rows))

        const failCount = checks.filter(c => c.status === "fail").length
        const warnCount = checks.filter(c => c.status === "warn").length

        // B-10 fix: Actually implement --fix to repair issues
        if (opts.fix && (failCount > 0 || warnCount > 0)) {
          console.log("\nAttempting repairs...")
          let repaired = 0

          // Create kernel for repairs (not instantiated at top-level to avoid cost when no fix needed)
          const kernel = new ResourceKernel({
            store: new FsResourceStore(resourceDir),
            trustStore: new TrustStore(),
            auditLogger: new AuditLogger(join(resourceDir, "audit")),
            cacheDir,
          })

          // Fix missing registry
          if (!existsSync(registryPath)) {
            try {
              await kernel.init({ force: true })
              console.log("  ✓ Created registry.json")
              repaired++
            } catch (err) {
              console.error(`  ✗ Failed to create registry: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          // Fix missing directories
          for (const type of ["skill", "agent", "workflow", "source"]) {
            const dir = join(resourceDir, "manifests", type)
            if (!existsSync(dir)) {
              try {
                const { mkdirSync } = require('fs')
                mkdirSync(dir, { recursive: true })
                console.log(`  ✓ Created manifests/${type}/`)
                repaired++
              } catch (err) {
                console.error(`  ✗ Failed to create manifests/${type}/: ${err instanceof Error ? err.message : String(err)}`)
              }
            }
          }

          // Fix missing cache directory
          if (!existsSync(cacheDir)) {
            try {
              const { mkdirSync } = require('fs')
              mkdirSync(cacheDir, { recursive: true })
              console.log("  ✓ Created cache directory")
              repaired++
            } catch (err) {
              console.error(`  ✗ Failed to create cache directory: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          if (repaired > 0) {
            console.log(`\n${repaired} issue(s) repaired. Run 'octopus resource doctor' again to verify.`)
          } else {
            console.log("\nNo repairs needed or possible.")
          }
        }

        if (failCount === 0 && warnCount === 0) {
          console.log(fmt.success("All checks passed"))
        } else if (failCount > 0) {
          console.error(fmt.error(`${failCount} check(s) failed`, "Run 'octopus resource init --force' to repair"))
          process.exitCode = 1
        } else {
          console.log(`\n${warnCount} warning(s), ${failCount} failure(s)`)
        }
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
