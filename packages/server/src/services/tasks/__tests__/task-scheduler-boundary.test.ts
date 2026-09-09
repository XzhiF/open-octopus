// packages/server/src/services/tasks/__tests__/task-scheduler-boundary.test.ts
//
// ADR-0021 票03 — THE GATEKEEPER.
//
// The whole point of 票03 was that the task domain stops being a participant in
// scheduling: no more parked `schedules` envelopes, no more `schedule_executions`
// link rows, no more reaching into the pump. `task-lifecycle-service.ts` puts it in
// words — "the ONE unit in the system allowed to know both worlds" — and then points
// AT THIS FILE: "see the boundary rule in __tests__/task-scheduler-boundary.test.ts
// for what is and is not allowed to cross from the tasks domain". So the boundary is
// this test's to define, and it is defined as a REGRESSION GUARD: the tree is clean
// today (the 票03 rewrite emptied the coupling), and this file's job is to go red the
// moment anyone welds it back.
//
// Two rules over every non-test source file under services/tasks/ (recursively):
//
//   (a) DAO / service imports. The schedule CONFIG layer (the envelope: schedules
//       rows and their queue states, the pump's materializer, the reaper, the status
//       listener) is banned outright. The RUN DAO (schedule-run-dao) is allowed ONLY
//       as the shared concurrency meter — contract §9 designates `countActiveWork()`
//       (live job fires + live task execution rows) as the single gate BOTH domains
//       consult, and the meter lives there; the allowlist below pins exactly which
//       files may import it and which methods they may call on it, so the one
//       sanctioned read cannot quietly grow back into schedule-state access.
//
//   (b) Table access. No SQL string may reference `schedules`,
//       `schedule_executions` or `schedule_workspaces`.
//
// What is deliberately NOT banned:
//   * the bare word "schedule" in code — `source_schedule_id` on a workspace row,
//     `scheduleId` variables, the pump's own run-state columns; none of those couple
//     a task to the schedule tables. Both rules above are table- and module-precise.
//   * the pure scheduler helpers (`../scheduler/concurrency`, `ws-launch`,
//     `orchestration-strategy`, `template-resolver`, `task-ws-name`). They are
//     constants and pure functions with no schedule state, and duplicating them into
//     the task domain would fork single-source-of-truth logic (the cap number, the
//     ws naming rule, the composite threshold) — drift is the worse failure mode.
//     Per-entry WHY lives in PURE_SCHEDULER_ALLOW below.
//
// Comments are stripped BEFORE scanning, because every file here legitimately carries
// prose HISTORY about the coupling it no longer has ("it used to be a schedules row",
// the deleted-method lists, the moved-function notes) — matching prose would make the
// gate fire on documentation. The stripper is a string-aware state machine rather
// than a regex pair on purpose, and its own correctness is pinned by the unit cases
// at the bottom: the failure mode to fear is a stripper that OVER-EATS code, because
// a shredded input makes the whole gate pass vacuously. A broken file glob does the
// same thing, so the scanned file list itself is asserted non-trivial.

import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// ── the scanned tree ─────────────────────────────────────────────────

const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Every non-test .ts source under services/tasks/, recursively. Test files are out
 *  of scope by definition: they legitimately contain strings like
 *  `SELECT COUNT(*) FROM schedules` precisely to ASSERT the decoupling (contract
 *  新行为 #1), so gating them would make the gatekeeper ban its own proof. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue
      out.push(...listSourceFiles(full))
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out.sort()
}

// ── the boundary rules ───────────────────────────────────────────────

/** Schedule-domain modules/symbols tasks code may NEVER reference (comment-stripped).
 *  These are the envelope, the pump and the mirrors 票03 deleted. */
const BANNED_IMPORTS = [
  { token: "ScheduleConfigDAO", why: "the schedules-row config DAO — the envelope 票03 deleted" },
  { token: "schedule-config-dao", why: "its module" },
  { token: "scheduler-service", why: "SchedulerService — enqueueJob / createJob task_spec materialization / the pump's definitions" },
  { token: "orphan-reaper", why: "deleted with 票03 — the lifecycle job's reconcile pass replaces it, over executions rows" },
  { token: "schedule-status-listener", why: "deleted with 票03 — the job mirrors tasks.status itself" },
  { token: "ScheduleStatusListener", why: "the class above" },
]

/** The ONE sanctioned crossing into the schedule-run layer: the shared concurrency
 *  meter. Contract §9: `countActiveWork()` = live job fires + live task rows, the
 *  single gate both domains consult. Pinned per-file AND per-method, so the meter
 *  cannot grow back into schedule state (an insert/claim/mark against the run DAO
 *  from the task domain = the envelope resurrected). */
const RUN_DAO_ALLOW = {
  moduleTokens: ["schedule-run-dao", "ScheduleRunDAO"],
  files: [
    // Arms + launches task instances; needs the meter to decide when a slot is free
    // (launchQueued claims 'pending' rows while countActiveWork < cap).
    "task-lifecycle-service.ts",
    // Arms composite CHILD runs; applies the same cap before starting one
    // (over cap the child stays 'pending' and the job claims it — task-child-run).
    "task-child-run.ts",
  ],
  methods: ["countActiveWork"],
}

/** Pure scheduler helpers: constants + side-effect-free functions, no schedule state
 *  reachable through them. Each entry exists because the task domain needs the SAME
 *  byte-for-byte value as the scheduler and copying would fork it. */
const PURE_SCHEDULER_ALLOW = [
  { token: "scheduler/concurrency", why: "MAX_PARALLEL_WORKSPACES + STALE_CLAIMED_THRESHOLD_MS: the cap number and its stale threshold, single source (ADR-0021)" },
  { token: "scheduler/ws-launch", why: "formatBranchSuffix / computeTaskWsLaunchParams / isCompositeWorkflowConfig — pure naming + composite probe; prebuild and first-build must agree byte-for-byte or ws reuse never hits" },
  { token: "scheduler/orchestration-strategy", why: "COMPOSITION_WF_REF — the composition workflow ref as ONE constant (it used to be duplicated per domain)" },
  { token: "scheduler/template-resolver", why: "resolveInputValues / parseWorkflowInputDefs — placeholder + input-def parsing, no IO, no state" },
  { token: "scheduler/task-ws-name", why: "taskWorkspaceName — the display-naming rule shared with the chat path" },
]

/** Table names that may not appear inside any string literal (rule b). Whole-word. */
const BANNED_TABLES = ["schedule_executions", "schedule_workspaces", "schedules"]

// ── string-aware comment stripper ────────────────────────────────────

type Mode = "code" | "line" | "block" | "squote" | "dquote" | "template"

/**
 * Replace line (`//` …) and block (`/*` … `*​/`) comments with empty spans (newlines
 * kept, so line
 * appeared OUTSIDE comments.
 *
 * Code positions are copied VERBATIM (a string's characters remain in `code` so
 * import specifiers can still be matched); only comments vanish. A regex stripper
 * (`src.replace(/\/\/.*$/gm, "")`) would eat the rest of `const url = "https://…"`
 * — deleting code that may hold a violation, which is the one outcome a gatekeeper
 * must not produce. Template literals nest (`${ … }` re-enters code mode), hence
 * the brace-depth stack instead of a "find the next backtick" scan.
 */
function stripComments(src: string): { code: string; strings: string[] } {
  const strings: string[] = []
  let out = ""
  let mode: Mode = "code"
  let cur = ""
  let escaped = false
  /** braceDepth recorded when each open `${` was entered; the matching `}` at that
   *  depth closes the substitution and returns to template-text mode. */
  const subStack: number[] = []
  let braceDepth = 0

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const c2 = src[i + 1]

    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c }
      continue
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") { mode = "code"; i++ }
      else if (c === "\n") out += c
      continue
    }

    if (mode === "code") {
      if (c === "/" && c2 === "/") { mode = "line"; i++; continue }
      if (c === "/" && c2 === "*") { mode = "block"; i++; continue }
      if (c === "'") { mode = "squote"; cur = ""; escaped = false; out += c; continue }
      if (c === '"') { mode = "dquote"; cur = ""; escaped = false; out += c; continue }
      if (c === "`") { mode = "template"; cur = ""; escaped = false; out += c; continue }
      if (c === "{") braceDepth++
      if (c === "}") {
        if (subStack.length > 0 && braceDepth === subStack[subStack.length - 1]) {
          subStack.pop()
          mode = "template"
          cur = ""
          escaped = false
          out += c
          continue
        }
        braceDepth--
      }
      out += c
      continue
    }

    // any string mode: copy verbatim into out; collect into cur for the rule-b scan
    if (mode === "squote" || mode === "dquote") {
      const quote = mode === "squote" ? "'" : '"'
      if (escaped) { cur += c; escaped = false; out += c; continue }
      if (c === "\\") { cur += c; escaped = true; out += c; continue }
      if (c === quote) { strings.push(cur); mode = "code"; out += c; continue }
      if (c === "\n") { strings.push(cur); mode = "code"; out += c; continue } // unterminated (invalid TS) — recover
      cur += c
      out += c
      continue
    }

    // template
    if (escaped) { cur += c; escaped = false; out += c; continue }
    if (c === "\\") { cur += c; escaped = true; out += c; continue }
    if (c === "`") { strings.push(cur); mode = "code"; out += c; continue }
    if (c === "$" && c2 === "{") {
      // Consume BOTH chars of the opener: the `{` of `${` is not a depth-increasing
      // brace, so the recorded depth is the level the closing `}` must return to.
      strings.push(cur)
      cur = ""
      subStack.push(braceDepth)
      mode = "code"
      out += "${"
      i++
      continue
    }
    cur += c
    out += c
  }

  if (mode === "squote" || mode === "dquote" || mode === "template") strings.push(cur)
  return { code: out, strings }
}

/** Rule b: does this string content reference one of the three schedule tables?
 *  Whole-word, so `schedule_workspaces_all` and the bare word "schedule" pass. */
function sqlTableHit(text: string): string | null {
  for (const t of BANNED_TABLES) {
    if (new RegExp(`\\b${t}\\b`).test(text)) return t
  }
  return null
}

// ── the gate ─────────────────────────────────────────────────────────

describe("票03 boundary — services/tasks must not couple back to the scheduler", () => {
  const files = listSourceFiles(TASKS_DIR)

  it("the scan actually sees the source tree (a broken glob must not pass the gate vacuously)", () => {
    // The bound is deliberately loose so the test does not churn when someone SPLITs
    // a file — but it must never drop near the floor, and the files that DEFINE the
    // new shape must be present (a wrong dir would otherwise make every rule below
    // trivially green).
    expect(files.length).toBeGreaterThan(10)
    const names = files.map((f) => path.basename(f))
    for (const required of [
      "task-lifecycle-service.ts",
      "task-child-run.ts",
      "task-materialize.ts",
      "tasks-service.ts",
      "archiving-service.ts",
      "derive-task-view.ts",
    ]) {
      expect(names, `${required} must be inside the scanned set`).toContain(required)
    }
  })

  it("the run-DAO allowlist covers exactly the files that import it today, and is not empty", () => {
    expect(RUN_DAO_ALLOW.files.length).toBeGreaterThan(0)
    expect(RUN_DAO_ALLOW.methods.length).toBeGreaterThan(0)
    expect(PURE_SCHEDULER_ALLOW.length).toBeGreaterThan(0)
    // Pin the allowlist to reality: it is a CEILING, not a wish list. When the meter
    // moves out of schedule-run-dao, shrink this list rather than leaving a dead entry.
    const importers = files.filter((f) =>
      RUN_DAO_ALLOW.moduleTokens.some((t) => stripComments(fs.readFileSync(f, "utf-8")).code.includes(t)),
    )
    expect(importers.map((f) => path.basename(f)).sort()).toEqual([...RUN_DAO_ALLOW.files].sort())
  })

  it("every tasks source file respects the import ban, the meter allowance and the table ban", () => {
    const violations: string[] = []

    for (const file of files) {
      const rel = path.relative(TASKS_DIR, file)
      const { code, strings } = stripComments(fs.readFileSync(file, "utf-8"))

      // (a) hard-banned schedule-domain modules.
      for (const b of BANNED_IMPORTS) {
        if (code.includes(b.token)) {
          violations.push(`${rel}: references banned schedule module "${b.token}" — ${b.why}`)
        }
      }

      // (a) the one sanctioned crossing: the run DAO, as the concurrency meter ONLY.
      if (RUN_DAO_ALLOW.moduleTokens.some((t) => code.includes(t))) {
        if (!RUN_DAO_ALLOW.files.includes(path.basename(file))) {
          violations.push(`${rel}: imports the schedule-run DAO — only ${RUN_DAO_ALLOW.files.join(" / ")} may, as the concurrency meter (contract §9)`)
        }
        const methods = new Set<string>()
        for (const m of code.matchAll(/new\s+ScheduleRunDAO\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*([A-Za-z_$][\w$]*)/g)) methods.add(m[1])
        for (const m of code.matchAll(/\brunDAO\s*\.\s*([A-Za-z_$][\w$]*)/g)) methods.add(m[1])
        for (const method of methods) {
          if (!RUN_DAO_ALLOW.methods.includes(method)) {
            violations.push(`${rel}: calls ScheduleRunDAO.${method}() — the run DAO is allowed ONLY as the ${RUN_DAO_ALLOW.methods.join("/")} meter (contract §9); anything else re-couples task state onto schedule rows`)
          }
        }
      }

      // (a) imports: any scheduler/schedule-path import must be an EXPLICIT allowlist
      // entry. A new crossing has to come with a reason, or goes through the meter.
      for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]
        const schedulerPath = spec.includes("scheduler/") || spec.includes("schedule-")
        if (!schedulerPath) continue
        if (spec.includes("scheduler/scheduler-service") || spec.includes("/scheduler-service")) continue // caught as banned above
        const known =
          RUN_DAO_ALLOW.moduleTokens.some((k) => spec.includes(k)) ||
          PURE_SCHEDULER_ALLOW.some((k) => spec.includes(k.token))
        if (!known) {
          violations.push(`${rel}: imports "${spec}" — a scheduler/schedule module not in the allowlist (add an entry WITH a reason, or drop the import)`)
        }
      }

      // (b) SQL strings referencing the schedule tables (comments already gone).
      for (const s of strings) {
        const hit = sqlTableHit(s)
        if (hit) violations.push(`${rel}: string references the "${hit}" table: ${JSON.stringify(s.slice(0, 140))}`)
      }
    }

    expect(violations, `票03 boundary violations:\n${violations.join("\n")}`).toEqual([])
  })
})

// ── the stripper, tested ─────────────────────────────────────────────
//
// These cases exist because the gatekeeper's real failure mode is PASSING WHEN IT
// SHOULDN'T: an over-eating comment stripper deletes code that holds a violation and
// the gate goes green. So the stripper is pinned — prose removed, every code
// character kept, including inside strings and template substitutions.

describe("票03 boundary — the comment stripper is code-preserving", () => {
  it("blanks line and block comments", () => {
    const src = `const a = 1 // schedules table is gone\n/* FROM schedules\n   UPDATE schedule_executions */\nconst b = 2\n`
    const { code, strings } = stripComments(src)
    expect(code).toContain("const a = 1")
    expect(code).toContain("const b = 2")
    expect(code).not.toContain("FROM schedules")
    expect(code).not.toContain("schedules table is gone")
    expect(strings).toEqual([])
  })

  it("does NOT treat // inside a string as a comment (a naive regex eats the rest of the line)", () => {
    const src = `const url = "https://x/y" // trailing comment\nconst keep = "FROM schedules" // and this\n`
    const { code, strings } = stripComments(src)
    expect(code).toContain("const keep")
    expect(strings).toContain("https://x/y")
    expect(strings).toContain("FROM schedules")
    expect(code).not.toContain("trailing comment")
  })

  it("does NOT treat /* inside a string or template as a comment opener", () => {
    const src = "const sql = `SELECT 1 /* still a template`\nconst z = 3\n"
    const { code, strings } = stripComments(src)
    expect(code).toContain("const z = 3")
    expect(strings.join("\n")).toContain("/* still a template")
  })

  it("keeps strings INSIDE a template ${…} substitution; strips a comment inside the substitution; keeps template text verbatim", () => {
    // `${ db.prepare('…') /* gone */ }` — the comment sits in the CODE region of the
    // substitution, so it must be stripped. The ` /* kept */` after the closing `}` is
    // template TEXT (a string), so it must NOT be stripped — the stripper has to return
    // to template mode after the substitution, or it would eat the rest of the file.
    const src = "const t = `prefix ${ db.prepare('SELECT * FROM schedules') /* gone */ } /* kept */ suffix`\nconst w = 9\n"
    const { code, strings } = stripComments(src)
    expect(strings).toContain("SELECT * FROM schedules")
    expect(code).toContain("db.prepare")
    expect(code).not.toContain("gone")
    expect(code).toContain("const w = 9")
    // template text after the substitution survives (proves mode returned to template)
    expect(strings.join("\n")).toContain("/* kept */ suffix")
    expect(code).toContain("const t")
  })

  it("handles nested braces inside a ${…} block without closing the substitution early", () => {
    const src = "const t = `x ${ ({ a: 1 }) } y`\nconst k = 'tail'\n"
    const { code, strings } = stripComments(src)
    expect(code).toContain("({ a: 1 })")
    expect(strings).toContain("x ")
    expect(strings).toContain(" y")
    expect(strings).toContain("tail")
  })

  it("detects the banned tables only as whole words", () => {
    expect(sqlTableHit("SELECT * FROM schedule_executions WHERE 1")).toBe("schedule_executions")
    expect(sqlTableHit("UPDATE schedules SET x=1")).toBe("schedules")
    expect(sqlTableHit("INSERT INTO schedule_workspaces (id) VALUES (1)")).toBe("schedule_workspaces")
    expect(sqlTableHit("schedule_workspaces_archive")).toBeNull()
    expect(sqlTableHit("the scheduler pumps its schedule every minute")).toBeNull()
  })
})
