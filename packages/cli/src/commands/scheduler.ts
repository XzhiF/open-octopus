import { Command } from "commander"
import chalk from "chalk"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import * as yaml from "js-yaml"
import { SchedulerConfigSchema, validateSchedulerConfig } from "@octopus/shared"
import type { SchedulerConfig } from "@octopus/shared"

// ── Minimal cron next-run calculator ────────────────────────────────
// ponytail: inline cron — no new dep for 5-field next-run only

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const vals: number[] = []
    for (let i = min; i <= max; i++) vals.push(i)
    return vals
  }
  // Handle */N step
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10)
    if (isNaN(step) || step < 1) return [min]
    const vals: number[] = []
    for (let i = min; i <= max; i += step) vals.push(i)
    return vals
  }
  // Handle comma list: 1,4,7,10
  if (field.includes(",")) {
    return field.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
  }
  // Handle range: 1-5
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map((s) => parseInt(s.trim(), 10))
    if (isNaN(lo) || isNaN(hi)) return [min]
    const vals: number[] = []
    for (let i = lo; i <= hi; i++) vals.push(i)
    return vals
  }
  const n = parseInt(field, 10)
  return isNaN(n) ? [min] : [n]
}

function nextCronRun(cron: string, now: Date = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const days = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const weekdays = parseCronField(parts[4], 0, 7)

  // Normalize: cron uses 0 and 7 for Sunday
  const normalizedWeekdays = [...new Set(weekdays.map((d) => (d === 7 ? 0 : d)))]
  const dayIsWild = parts[2] === "*"
  const weekdayIsWild = parts[4] === "*"

  // Search up to 366 days ahead
  const limit = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000)
  const cursor = new Date(now)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  while (cursor < limit) {
    const month = cursor.getMonth() + 1
    if (!months.includes(month)) {
      cursor.setDate(1)
      cursor.setMonth(cursor.getMonth() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    const day = cursor.getDate()
    const jsDay = cursor.getDay() // 0=Sun
    const dayMatch = dayIsWild || days.includes(day)
    const weekdayMatch = weekdayIsWild || normalizedWeekdays.includes(jsDay)
    // cron spec: if both day-of-month and day-of-week are restricted,
    // either match triggers execution (union). If one is *, the other must match.
    const dayOk = dayIsWild && weekdayIsWild
      ? true
      : dayIsWild
        ? weekdayMatch
        : weekdayIsWild
          ? dayMatch
          : dayMatch || weekdayMatch

    if (!dayOk) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    const hour = cursor.getHours()
    if (!hours.includes(hour)) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }

    const minute = cursor.getMinutes()
    if (!minutes.includes(minute)) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }

    return new Date(cursor)
  }

  return null
}

// ── Config loading ──────────────────────────────────────────────────

function resolveConfigPath(configOpt?: string): string | null {
  if (configOpt) return existsSync(configOpt) ? configOpt : null
  const candidates = [
    join(process.cwd(), "scheduler.yaml"),
    join(homedir(), ".octopus", "config", "scheduler.yaml"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function loadConfig(configOpt?: string): { config: SchedulerConfig; path: string } | null {
  const configPath = resolveConfigPath(configOpt)
  if (!configPath) {
    console.error(chalk.red("Error: No scheduler.yaml found"))
    console.error("Searched: ./scheduler.yaml, ~/.octopus/config/scheduler.yaml")
    console.error("Use --config <path> to specify a custom location")
    return process.exit(1) as never
  }
  const raw = readFileSync(configPath, "utf-8")
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err: any) {
    const lineMatch = err.message?.match(/line (\d+)/)
    const lineInfo = lineMatch ? `:${lineMatch[1]}` : ""
    console.error(chalk.red(`Error: ${configPath}${lineInfo}: ${err.reason || err.message}`))
    return process.exit(1) as never
  }
  try {
    const config = validateSchedulerConfig(parsed)
    return { config, path: configPath }
  } catch (err: any) {
    console.error(chalk.red(`Error: Invalid scheduler config in ${configPath}`))
    console.error(chalk.red(`  ${err.message}`))
    return process.exit(1) as never
  }
}

// ── Commands ────────────────────────────────────────────────────────

export const schedulerCmd = new Command("scheduler")
  .description("Scheduler task management commands")

schedulerCmd.command("list")
  .description("List all scheduled tasks")
  .option("--config <path>", "Path to scheduler.yaml")
  .action((options) => {
    const loaded = loadConfig(options.config)
    if (!loaded) return
    const { config } = loaded

    if (config.tasks.length === 0) {
      console.log(chalk.yellow("No tasks defined in scheduler.yaml"))
      return
    }

    // Table header
    const nameW = Math.max(4, ...config.tasks.map((t) => t.name.length)) + 2
    const cronW = Math.max(4, ...config.tasks.map((t) => t.cron.length)) + 2
    const header = `${"NAME".padEnd(nameW)}${"CRON".padEnd(cronW)}${"NEXT RUN".padEnd(22)}STATUS`
    console.log(chalk.bold(header))

    for (const task of config.tasks) {
      const next = nextCronRun(task.cron)
      const nextStr = next ? next.toISOString().replace("T", " ").slice(0, 16) : "N/A"
      const status = task.enabled ? chalk.green("enabled") : chalk.gray("disabled")
      console.log(`${task.name.padEnd(nameW)}${task.cron.padEnd(cronW)}${nextStr.padEnd(22)}${status}`)
    }
  })

schedulerCmd.command("next <task>")
  .description("Show next execution time for a task")
  .option("--config <path>", "Path to scheduler.yaml")
  .action((taskName, options) => {
    const loaded = loadConfig(options.config)
    if (!loaded) return
    const { config } = loaded
    const task = config.tasks.find((t) => t.name === taskName)

    if (!task) {
      console.error(chalk.red(`Error: Task not found: ${taskName}`))
      const names = config.tasks.map((t) => t.name).join(", ")
      if (names) console.error(`Available tasks: ${names}`)
      return process.exit(1)
    }

    const next = nextCronRun(task.cron)
    if (!next) {
      console.error(chalk.red(`Error: Could not compute next run for cron "${task.cron}"`))
      return process.exit(1)
    }

    console.log(`${task.name}: ${next.toISOString().replace("T", " ").slice(0, 16)}`)
    console.log(chalk.gray(`  cron: ${task.cron}`))
    console.log(chalk.gray(`  timezone: ${config.global.timezone}`))
  })

schedulerCmd.command("validate")
  .description("Validate scheduler.yaml syntax")
  .option("--config <path>", "Path to scheduler.yaml")
  .action((options) => {
    const configPath = resolveConfigPath(options.config)
    if (!configPath) {
      console.error(chalk.red("Error: No scheduler.yaml found"))
      return process.exit(1)
    }

    let raw: string
    try {
      raw = readFileSync(configPath, "utf-8")
    } catch (err: any) {
      console.error(chalk.red(`Error: Cannot read file: ${err.message}`))
      return process.exit(1)
    }

    let parsed: unknown
    try {
      parsed = yaml.load(raw)
    } catch (err: any) {
      // YAML parse error — extract line number
      const lineMatch = err.message?.match(/line (\d+)/)
      const lineInfo = lineMatch ? `:${lineMatch[1]}` : ""
      console.error(chalk.red(`Error: ${configPath}${lineInfo}: ${err.reason || err.message}`))
      return process.exit(1)
    }

    const result = SchedulerConfigSchema.safeParse(parsed)
    if (!result.success) {
      console.error(chalk.red("Validation errors:"))
      for (const issue of result.error.issues) {
        const path = issue.path.join(".") || "(root)"
        console.error(chalk.red(`  ${path}: ${issue.message}`))
      }
      return process.exit(1)
    }

    console.log(chalk.green(`scheduler.yaml is valid (${configPath})`))
    const cfg = result.data
    console.log(chalk.gray(`  ${cfg.tasks.length} task(s), ${cfg.retire_protected.length} protected, ${cfg.evolution_scope.length} scope(s)`))
  })
