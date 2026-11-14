// packages/web-app/e2e/helpers/cockpit-helpers.ts
//
// E2E helpers for the global cockpit (cockpit-v12) spec.
//
// Facts this file is built around (plans/cabin-cockpit-v12.md §Step 10):
//   - playwright.config.ts starts Vite only; the real backend must already be
//     listening at OCTOPUS_SERVER_URL ?? http://localhost:3001.
//   - A cabin seeded over REST gets a real workspace + main session (so the
//     cockpit composer / bridge telemetry are exercised against real data).
//   - A `task` job dispatched with `ref_id` omitted makes the server create a
//     real task + task session (that is the production dispatch path). The E2E
//     never sends a chat message; the dispatch itself is the fixture.
//   - Cleanup is safety-scoped: only cabins whose name carries the E2E prefix
//     AND whose directory sits under os.tmpdir() are ever deleted.
//
// Console auditing lives here too because the cockpit has two known-benign
// error sources that must not turn the suite red:
//   1. the invalid-deep-link step intentionally mounts a JobFace with a bogus
//      id before CockpitUrlSync rewrites the URL → one or more expected 404s;
//   2. client-side route navigation aborts in-flight fetches → net::ERR_ABORTED
//      / "Failed to fetch" / AbortError.
// Both are filtered explicitly (never "all errors") and the reason is written
// next to the filter.

import { expect, request, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ── Constants ───────────────────────────────────────────────────────────

export const SERVER_URL = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"

/** Every seeded cabin name starts with this. Doubles as a cleanup guard. */
export const CABIN_PREFIX = "E2E-Cockpit-"

/** mkdtemp prefix; the per-cabin suffix is random. Cleanup only rm -rf this shape. */
const CABIN_DIR_PREFIX = "octopus-e2e-cockpit-"

export function log(msg: string): void {
  process.stdout.write(`[e2e-cockpit] ${msg}\n`)
}

export function logError(msg: string): void {
  process.stderr.write(`[e2e-cockpit] ${msg}\n`)
}

// ── Server availability (R1: real backend, no mocks) ────────────────────

/**
 * Probe GET /api/cabins. Mirrors the existing task-domain helper's contract:
 * the spec does `test.skip(!ok, ...)` so a machine without a backend reports
 * skips instead of hard failures.
 */
export async function serverReachable(): Promise<boolean> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/cabins`, { timeout: 5000 })
    return res.ok()
  } catch {
    return false
  } finally {
    await ctx.dispose()
  }
}

// ── REST plumbing ───────────────────────────────────────────────────────

async function api<T>(ctx: APIRequestContext, pathname: string, init?: Parameters<APIRequestContext["fetch"]>[1]): Promise<T> {
  const res = await ctx.fetch(`${SERVER_URL}${pathname}`, init)
  const text = await res.text()
  if (!res.ok()) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} failed (${res.status()}): ${text}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

export interface CabinDTO {
  id: string
  name: string
  path: string
  workspace_id: string | null
  main_session_id: string | null
  status: string
  version: number
}

export interface CabinJobDTO {
  id: string
  cabin_id: string
  kind: "task" | "workflow" | "subagent"
  ref_id: string | null
  session_id: string | null
  title: string
  prompt: string | null
  created_at: string
}

export interface SeededCockpit {
  cabin: CabinDTO
  /** Temp directory created for this cabin (empty at creation, per API contract). */
  dir: string
  /** `?job=` target: workflow job with `ref_id` omitted. */
  workflowJob: CabinJobDTO
  /** `?job=` target: task job whose `ref_id` was created server-side. */
  taskJob: CabinJobDTO
}

/**
 * Server-side dispatch of a `task` job with `ref_id` omitted goes through the
 * production comm path: the server creates the task + a task session and then
 * wakes it (`POST /api/agent/sessions/:id/chat`, gated by
 * OCTOPUS_CHAT_AUTO_WAKE). The E2E only needs the job/task rows — letting the
 * task-author agent run would spend real LLM tokens, write a real session and
 * keep recreating `.task/` in our temp dir after cleanup.
 *
 * The agent process carries `--plugin-dir=<cabinDir>/.task` on its command line.
 * `cabinDir` is a unique mkdtemp path with our prefix, so matching on it is
 * exact and cannot hit any other process. Best-effort + platform-guarded: on
 * systems without `ps` this is a no-op and cleanup's rm still applies.
 */
function fixtureAgentPids(cabinDir: string): number[] {
  const marker = `${cabinDir}${path.sep}.task`
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
    })
    return out.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!match || !match[2].includes(marker)) return []
      const pid = Number(match[1])
      return Number.isFinite(pid) ? [pid] : []
    })
  } catch {
    return []
  }
}

/** SIGTERM every fixture agent for `cabinDir`; poll briefly for a late spawn. */
async function suppressFixtureAgents(cabinDir: string, waitMs = 2_500): Promise<boolean> {
  const deadline = Date.now() + waitMs
  let killed = false
  for (;;) {
    for (const pid of fixtureAgentPids(cabinDir)) {
      try {
        process.kill(pid, "SIGTERM")
        killed = true
        log(`suppressed fixture agent pid ${pid} for ${cabinDir}`)
      } catch (err) {
        logError(`suppress fixture agent ${pid} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (Date.now() >= deadline) return killed
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// ── Seed ────────────────────────────────────────────────────────────────

/**
 * Create a throwaway cabin in a fresh os.tmpdir() directory and dispatch two
 * real jobs:
 *   - `workflow` with `ref_id` omitted (empty run tab, explicit empty states);
 *   - `task` with `ref_id` omitted (server creates the task entity).
 * Returns the ids the spec deep-links to.
 */
export async function seedCockpitCabin(): Promise<SeededCockpit> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), CABIN_DIR_PREFIX))
  const name = `${CABIN_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ctx = await request.newContext()
  try {
    const { cabin } = await api<{ cabin: CabinDTO }>(ctx, "/api/cabins", {
      method: "POST",
      data: { name, path: dir, requirements: "E2E smoke fixture — safe to delete." },
      headers: { "Content-Type": "application/json" },
    })

    if (!cabin.name.startsWith(CABIN_PREFIX)) {
      throw new Error(`seed sanity failed: cabin name ${cabin.name} lacks ${CABIN_PREFIX}`)
    }

    const { job: workflowJob } = await api<{ job: CabinJobDTO }>(ctx, `/api/cabins/${cabin.id}/jobs`, {
      method: "POST",
      data: {
        kind: "workflow",
        title: "E2E-Cockpit · 工作流作业",
        prompt: "E2E fixture: workflow job with no execution attached.",
        priority: 0,
      },
      headers: { "Content-Type": "application/json" },
    })

    const { job: taskJob } = await api<{ job: CabinJobDTO }>(ctx, `/api/cabins/${cabin.id}/jobs`, {
      method: "POST",
      data: {
        kind: "task",
        title: "E2E-Cockpit · 任务作业",
        prompt: "E2E 播种，无需执行。",
        // `inferred` keeps the server-side wake on the confirmation path instead
        // of the "explicit self-approve and execute" path.
        mandate: { strength: "inferred", scope: "e2e" },
        priority: 0,
      },
      headers: { "Content-Type": "application/json" },
    })

    log(`seeded cabin ${cabin.id} (${cabin.name}) at ${dir}; jobs ${workflowJob.id} / ${taskJob.id}`)

    // See suppressFixtureAgents(): the task dispatch wakes a real agent; the
    // fixture only needs the rows. Best-effort kill keeps the E2E token-free.
    await suppressFixtureAgents(dir)

    return { cabin, dir, workflowJob, taskJob }
  } catch (err) {
    // Never leave a half-seeded directory behind on a failed seed.
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  } finally {
    await ctx.dispose()
  }
}

// ── Cleanup safety ──────────────────────────────────────────────────────

/**
 * Refuse to touch anything that is not demonstrably ours:
 *   - name must carry CABIN_PREFIX;
 *   - the directory must be under os.tmpdir() (realpath, so symlinks cannot
 *     smuggle in a user path);
 *   - the directory basename must carry the mkdtemp prefix.
 */
function assertOwnedCabin(cabin: CabinDTO): void {
  const tmpRoot = fs.realpathSync(os.tmpdir())
  let real = path.resolve(cabin.path)
  try {
    real = fs.realpathSync(cabin.path)
  } catch {
    // Directory already gone: the resolved path is still enough to prove scope.
  }
  const underTmp = real === tmpRoot || real.startsWith(tmpRoot + path.sep)
  const ownedDir = path.basename(real).startsWith(CABIN_DIR_PREFIX)
  if (!cabin.name.startsWith(CABIN_PREFIX) || !underTmp || !ownedDir) {
    throw new Error(
      `refusing to delete non-E2E cabin ${cabin.id} (name=${cabin.name}, path=${cabin.path})`,
    )
  }
}

/**
 * Delete the seeded cabin + its temp directory.
 *
 * The server cascades jobs / tasks / sessions / workspace. CabinService refuses
 * to delete a cabin that still has a `running` task (a real dispatch can move
 * the task out of draft), so live tasks are aborted first via the real endpoint.
 *
 * Failures are printed and rethrown — a silent leak would poison later runs.
 */
export async function cleanupCabin(id: string): Promise<void> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/cabins/${id}`)
    if (res.status() === 404) {
      log(`cleanup: cabin ${id} already gone`)
      return
    }
    if (!res.ok()) {
      throw new Error(`cleanup: GET /api/cabins/${id} failed (${res.status()}): ${await res.text()}`)
    }
    const { cabin } = (await res.json()) as { cabin: CabinDTO }
    assertOwnedCabin(cabin)

    // Abort a live task so the running-task guard in CabinService.delete cannot
    // block cleanup. Only `running` actually trips that guard; aborting a draft
    // returns 409 by contract, so don't even call it.
    try {
      const tasksRes = await ctx.get(`${SERVER_URL}/api/tasks?cabin_id=${encodeURIComponent(id)}`)
      if (tasksRes.ok()) {
        const body = (await tasksRes.json()) as { items?: Array<{ id: string; status: string }> }
        for (const task of body.items ?? []) {
          if (task.status !== "running") continue
          const abortRes = await ctx.post(`${SERVER_URL}/api/tasks/${task.id}/abort`)
          if (!abortRes.ok()) {
            logError(`cleanup: abort running task ${task.id} failed (${abortRes.status()})`)
          }
        }
      } else {
        logError(`cleanup: task list for ${id} failed (${tasksRes.status()}) — delete will decide`)
      }
    } catch (err) {
      logError(`cleanup: task abort pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const del = await ctx.delete(`${SERVER_URL}/api/cabins/${id}`)
    if (!del.ok()) {
      throw new Error(`cleanup: DELETE /api/cabins/${id} failed (${del.status()}): ${await del.text()}`)
    }
    log(`cleanup: deleted cabin ${id} (${cabin.name})`)

    // A server-spawned task-author agent can outlive the cabin row and recreate
    // `.task/` in the directory. Stop only the process whose command line names
    // this exact fixture directory, then remove the directory.
    await suppressFixtureAgents(cabin.path, 1_000)

    // The server never removes the user's directory (by design). This one is
    // ours — mkdtemp'd under tmpdir and re-validated above.
    fs.rmSync(cabin.path, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 250))
    fs.rmSync(cabin.path, { recursive: true, force: true })
  } catch (err) {
    logError(`cleanup FAILED for cabin ${id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    throw err
  } finally {
    await ctx.dispose()
  }
}

/** Snapshot of cabin ids+names, for the "seeded cabin is gone" assertion. */
export async function listCabinsViaApi(): Promise<Array<{ id: string; name: string }>> {
  const ctx = await request.newContext()
  try {
    const body = await api<{ cabins: Array<{ id: string; name: string }> }>(ctx, "/api/cabins")
    return body.cabins ?? []
  } finally {
    await ctx.dispose()
  }
}

// ── Navigation ──────────────────────────────────────────────────────────

export interface CockpitDeepLink {
  job?: string
  task?: string
  attn?: string
  tab?: string
  demo?: boolean
}

export function cockpitUrl(cabinId: string, link: CockpitDeepLink = {}): string {
  const params = new URLSearchParams()
  if (link.job) params.set("job", link.job)
  if (link.task) params.set("task", link.task)
  if (link.attn) params.set("attn", link.attn)
  if (link.tab) params.set("tab", link.tab)
  if (link.demo) params.set("demo", "1")
  const qs = params.toString()
  return `/cabin/${encodeURIComponent(cabinId)}/cockpit${qs ? `?${qs}` : ""}`
}

/** Navigate to a cockpit deep link and wait for the shell to render. */
export async function gotoCockpit(page: Page, cabinId: string, link: CockpitDeepLink = {}): Promise<void> {
  await page.goto(cockpitUrl(cabinId, link))
  await expect(page.getByTestId("cockpit-shell")).toBeVisible({ timeout: 30_000 })
}

// ── Console audit ───────────────────────────────────────────────────────

export interface ConsoleAudit {
  /** Every console error / page error text, unfiltered (diagnostics). */
  raw: string[]
  /** Errors left after the explicitly-documented filters. Assert this is []. */
  filtered: string[]
  /** Allow the next N 404 console lines (invalid-deep-link step only). */
  allow404(count?: number): void
  dispose(): void
}

/** Abort noise produced by client-side navigation, not by the product. */
function isNavigationAbort(text: string): boolean {
  return (
    /net::ERR_ABORTED/i.test(text) ||
    /Failed to fetch/i.test(text) ||
    /AbortError/i.test(text) ||
    /The operation was aborted/i.test(text) ||
    /signal is aborted/i.test(text)
  )
}

/**
 * Collect console + page errors and expose a filtered view.
 *
 * Filters (and only these):
 *   - expected 404s explicitly enabled by the caller (invalid deep link mounts a
 *     JobFace with `not-a-real-job` before the URL is rewritten);
 *   - navigation aborts (goto / route changes cancel in-flight fetches);
 *   - a 409 from `/round-diff` when a task has no round yet — the documented
 *     server contract, observed via the response listener rather than guessed.
 */
export function attachConsoleAudit(page: Page): ConsoleAudit {
  const audit: ConsoleAudit = {
    raw: [],
    filtered: [],
    allow404: (count = 3) => {
      allowed404 += count
    },
    dispose: () => {},
  }

  let allowed404 = 0
  /** 409s seen on /round-diff that the console line may refer to. */
  let expectedRoundDiff409 = 0

  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    audit.raw.push(text)
    if (isNavigationAbort(text)) return
    if (/status of 404/i.test(text) && allowed404 > 0) {
      allowed404 -= 1
      return
    }
    if (/status of 409/i.test(text) && expectedRoundDiff409 > 0) {
      expectedRoundDiff409 -= 1
      return
    }
    audit.filtered.push(text)
  }

  const onPageError = (err: Error) => {
    const text = err.stack ?? err.message
    audit.raw.push(`pageerror: ${text}`)
    if (isNavigationAbort(text)) return
    audit.filtered.push(`pageerror: ${text}`)
  }

  const onResponse = (res: import("@playwright/test").Response) => {
    if (res.status() === 409 && res.url().includes("/round-diff")) expectedRoundDiff409 += 1
  }

  page.on("console", onConsole)
  page.on("pageerror", onPageError)
  page.on("response", onResponse)

  audit.dispose = () => {
    page.off("console", onConsole)
    page.off("pageerror", onPageError)
    page.off("response", onResponse)
  }

  return audit
}

// ── DOM assertions ──────────────────────────────────────────────────────

export interface FirstButtonInfo {
  testId: string | null
  ariaLabel: string | null
  text: string
  /** Left edge in CSS pixels. */
  x: number
  /** Container's horizontal centre, for the "close is on the left" check. */
  centerX: number
}

/**
 * The first focusable DOM-order button inside `container`, with its x. Used by
 * the close-button audit: the contract is DOM order (not CSS `order`), and the
 * button must sit left of the container's centre.
 */
export async function firstFocusableButton(container: Locator): Promise<FirstButtonInfo | null> {
  return container.evaluate((root) => {
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    const button = buttons.find((b) => !b.disabled && b.tabIndex !== -1)
    if (!button) return null
    const box = root.getBoundingClientRect()
    const btnBox = button.getBoundingClientRect()
    return {
      testId: button.getAttribute("data-testid"),
      ariaLabel: button.getAttribute("aria-label"),
      text: (button.textContent ?? "").trim(),
      x: btnBox.left,
      centerX: box.left + box.width / 2,
    }
  })
}

/** `scrollWidth <= innerWidth + 1` on the document element. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    ),
    innerWidth: window.innerWidth,
  }))
  expect(
    metrics.scrollWidth,
    `${label}: horizontal overflow (scrollWidth=${metrics.scrollWidth}, innerWidth=${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1)
}

/** Screenshot path under the OS temp dir — never inside the repo. */
export function tempScreenshotPath(name: string): string {
  const dir = path.join(os.tmpdir(), "octopus-cockpit-e2e")
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}
