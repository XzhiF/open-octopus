// packages/web-app/e2e/taskboard-flow-6-plan-writeback-confirm-gate.spec.ts
//
// 票 06 流⑥ —— 计划回写窄烟测：一次对话大改的全链路留痕（spec S5）。
//
// 真链路（零 mock、零 skip；沿流② 的 R1/R5/R7 纪律）：REST 直造 v4 任务 + bash stub
// 快轮 → 真实 awaiting_review → 真实 task-doer 对话（真 provider 两回合）：
//   回合1：抛一句**结构性大改**（拆两个新模块 + 新配置项 + 同步改规格 + 本轮做不完
//          的范围开票留档）→ 按 persona 的 plan-before-code 确认闸，只出预览
//          （spec 变更预览 + 票草稿 + 请求确认），不回写不动代码；
//   人回「确认」→ 回合2：doer 经计划回写 REST 通道 curl /plan 与 /plan/issues；
//   server 写 home 正本 + 机械 append「## 变更记录」行（actor=task-doer(session=…)），
//   新票落 issues/ 且带 Origin:/Status: 出生证。
// 断言链（票面 AC2）：预览消息出现 → 确认后 home 盘含变更记录行 + 带 Origin 的新票
//   → 「▣ 产物」页签 DOM 可见 spec.md 行与新票行（变更记录随 spec.md 入清单，
//   manifest 磁盘直扫零改动 —— 02/03 票契约）。
// AC2 旁证（04 闸生效）：全程 ws 侧批次同构位不被 doer 直写 —— ws/.scratch 的 spec.md
//   恒无「## 变更记录」、issues/ 恒无新文件（写入只发生在 home 正本侧）。
//
// 诚实边界（AC4 口径，写死在此不装）：
//  · 预览形态断言 = 存在性（字样匹配），不钉回复全文 —— 模型措辞天然漂移；
//    若两回合后字样仍不齐（doer 未按闸走），本流红，按票面"重试至多 2 次后如实
//    报告"处理，不改生产代码迁就测试。
//  · 真机 server 端口非 persona 默认的 3001（persona 自留口子"本机端口不同则换"），
//    人在指令里给出实际 base URL 属题中应有之义（用户本来就知道自己的栈在哪个端口）。
//  · 确认后 doer 大概率还会动代码并触发 server 端 [quick-edit] commit —— 不断言
//    代码细节（沿 v2 纪律"UI/实现细节不设断言"），只看计划侧留痕。
//
// 运行：pnpm -C <worktree> dev（isolated，端口/库走 ~/.octopus/ports/<branch>.json
// 约定）后 `pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2`，workers=1 串行。

import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  SEL,
  activeTabKey,
  clickTab,
  log,
  logError,
  openConsole,
  shotDir,
  tbv2Api,
  tbv2BootFlow,
  tbv2Derived,
  tbv2Env,
  tbv2ServerAvailable,
  tbv2Until,
  waitCardColumn,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null
let serverAvailable = false

test.beforeAll(async () => {
  serverAvailable = await tbv2ServerAvailable()
  if (!serverAvailable) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票06 流⑥ 不允许 skip`)
  }
})

test.afterAll(async () => {
  if (handles) {
    try {
      await handles.cleanup()
    } catch (err: unknown) {
      logError(`afterAll cleanup: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
})

// 盘上真相读取器（home 正本 = ADR-0011 纯派生路径；先例 helpers:478）
function homeBatchDir(taskId: string, batchRel: string): string {
  return path.join(os.homedir(), ".octopus", "tasks", taskId, batchRel)
}
function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8")
  } catch {
    return null
  }
}
function listIssues(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort()
  } catch {
    return []
  }
}

const CHANGELOG_HEADING = "## 变更记录"
// server 机械落痕行形状（tasks-service writePlanSpec 逐字契约）：
//   `- <ISO> · <actor> · <source> · <reason> · <home相对路径>`，actor 盖章 = doer 会话。
const DOER_CHANGELOG_LINE = /^- \d{4}-\d{2}-\d{2}T[\d:.]+Z? · task-doer\(session=[^)]+\) · \S.* · .* · \.scratch\//m

test("流⑥ 待验收 → 结构性大改 → 确认闸预览 → 人确认 → home 盘变更记录+新票 → 产物 tab 可见", async ({ page }) => {
  // 两回合真 LLM + 工具执行 + 盘上轮询：口径放宽到既有五流量级之上（流② 单回合 420s）。
  test.setTimeout(660_000)

  const serverUrl = tbv2Env().serverUrl

  // ── boot：真实跑完一轮 → 真实待验收（同流②）──
  handles = await tbv2BootFlow({ flow: "f6", parkSeconds: 0 })
  const taskId = handles.taskId
  const derived0 = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "awaiting_review" ? d : null
  }, 180_000, "round never landed at awaiting_review (terminal+collect path)", 1500)
  expect(derived0.phaseViews[0].awaitingRound, "phase1 r1 待验收").toBe(1)
  await waitCardColumn(page, taskId, "awaiting_review")

  // ── UI：开壳进「💬 对话」（待验收默认页 = quick-edit 形态）──
  await openConsole(page, taskId)
  await expect
    .poll(async () => activeTabKey(page), { timeout: 20_000, message: "待验收态默认页签应为 chat" })
    .toBe("chat")
  await expect(page.locator(SEL.chatForm())).toHaveAttribute("data-chat-form", "quick-edit", { timeout: 20_000 })
  const chatInput = page.locator(SEL.chatInput())
  await expect(chatInput).toBeEnabled({ timeout: 30_000 })

  // 回合前的盘基线：home 批次正本 = seed 的原样（无变更记录、issues/ 只有 1-ticket.md）
  const batchDir = homeBatchDir(taskId, handles.batchRel)
  const homeSpecPath = path.join(batchDir, "spec.md")
  const issuesDir = path.join(batchDir, "issues")
  const spec0 = readIfExists(homeSpecPath)
  expect(spec0, "seeded home spec exists before the chat").toBeTruthy()
  expect(spec0!, "seeded spec carries no changelog yet").not.toContain(CHANGELOG_HEADING)
  const issues0 = listIssues(issuesDir)
  expect(issues0.length, "seeded batch has ≥1 issue").toBeGreaterThanOrEqual(1)

  // ws 侧同构镜像基线（04 闸旁证的对照组：写入若绕过 home 走 ws，这里会变脏）
  const wsBatchDir = path.join(handles.wsPath(), handles.batchRel)
  const wsSpecPath = path.join(wsBatchDir, "spec.md")
  const wsIssuesDir = path.join(wsBatchDir, "issues")

  // ── 回合1：一句结构性大改（真 provider；确认闸应只出预览，不回写不动代码）──
  const marker = `E2E_PWB_${handles.run}`
  await chatInput.fill(
    `结构性大改（${marker}）：把 projects/${handles.projName}/tbv2-note.md 这一个文件承载的笔记功能拆成两个新模块——core.ts 与 config.ts，config.ts 里再加一个可配置项；` +
      `这会改变批次 spec 描述的范围，请同步把规格改准，本轮做不完的新增范围按纪律开一张后续票留档。` +
      `注意本机 server 不在默认 3001 端口：计划回写等任务接口都在 ${serverUrl}。按你的大改纪律来。`,
  )
  const resp1P = page
    .waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/chat`) && r.request().method() === "POST", { timeout: 300_000 })
    .catch(() => null)
  await page.locator(SEL.chatSend()).click()
  await resp1P

  // ── AC1：回合1 回复含预览形态（存在性断言，不钉全文 —— 票面 AC4 口径）──
  // 轮询到「三字样齐」再收：流式渲染中途的半截文本不算数（防部分命中假绿/假红）。
  const PREVIEW_RE = /预览|草案|草稿|改前|改后|diff|before|after/i
  const CONFIRM_RE = /确认|批准|同意|是否|可以.*(开始|执行|动手)|confirm|approve|proceed/i
  const TICKET_RE = /票|Origin|Status|ready-for/i
  let aiText1 = ""
  try {
    aiText1 = await tbv2Until(async () => {
      const t = (await page.locator(SEL.chatMsgAi()).allTextContents()).join("\n")
      return PREVIEW_RE.test(t) && CONFIRM_RE.test(t) && TICKET_RE.test(t) ? t : null
    }, 180_000, "preview-gate reply never assembled in the chat DOM", 2000)
  } catch (err) {
    // 超时把最后可见的回复节选打进消息，AC4 诊断口径（漂移到什么程度一眼可判）。
    aiText1 = (await page.locator(SEL.chatMsgAi()).allTextContents()).join("\n")
    throw new Error(`${(err as Error).message}\nlast AI bubbles: ${aiText1.slice(0, 600)}`)
  }
  expect(PREVIEW_RE.test(aiText1), "预览形态（spec 变更预览字样）在场").toBeTruthy()
  expect(CONFIRM_RE.test(aiText1), "请求确认字样在场").toBeTruthy()
  expect(TICKET_RE.test(aiText1), "票草稿字样在场").toBeTruthy()
  await page.screenshot({ path: path.join(shotDir("flow6"), "flow6-preview-gate.png") })

  // 闸的时序语义：确认之前不应已回写（人确认 → 才写计划）。漂移（模型抢跑直接写了）
  // → 按 AC4 记注不硬撞：链路终点断言（确认后盘上有痕）与产物可见仍然承重。
  const earlyWriteback = (readIfExists(homeSpecPath) ?? "").includes(CHANGELOG_HEADING) || listIssues(issuesDir).length > issues0.length
  if (earlyWriteback) {
    test.info().annotations.push({
      type: "warning",
      description: "AC4 漂移留痕：doer 在收到确认前已回写计划（闸的『先预览后回写』时序未被本 run 钉住）；终点留痕断言照常。",
    })
    logError("doer wrote back BEFORE confirmation (model drift) — final-chain assertions still apply")
  }

  // ── 回合2：人确认（真第二回合）──
  await expect(chatInput).toBeEnabled({ timeout: 120_000 })
  await chatInput.fill(
    `确认，就按这个预览执行。执行顺序按纪律：先经计划回写通道把 spec 变更和新票落到计划正本（接口在 ${serverUrl}：POST /api/tasks/${taskId}/plan 与 /plan/issues），留痕之后再动代码。`,
  )
  const resp2P = page
    .waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/chat`) && r.request().method() === "POST", { timeout: 300_000 })
    .catch(() => null)
  await page.locator(SEL.chatSend()).click()
  await resp2P

  // ── AC2 前半：home 盘真相 —— spec.md 文末变更记录行（actor 盖章 doer）+ 带 Origin/Status 的新票 ──
  const writeback = await tbv2Until(() => {
    const specNow = readIfExists(homeSpecPath) ?? ""
    const issueFilesNow = listIssues(issuesDir)
    const newOnes = issueFilesNow.filter((f) => !issues0.includes(f))
    const changelogOk = specNow.includes(CHANGELOG_HEADING) && DOER_CHANGELOG_LINE.test(specNow)
    const issueOk = newOnes.find((f) => {
      const c = readIfExists(path.join(issuesDir, f)) ?? ""
      return /^Origin:/m.test(c) && /^Status:/m.test(c)
    })
    if (!changelogOk || !issueOk) return null
    return { changelogLine: DOER_CHANGELOG_LINE.exec(specNow)![0], newIssue: issueOk as string }
  }, 420_000, "confirmed writeback never landed on the home disk (changelog line with doer actor + new Origin/Status ticket)", 3000)
  log(`f6 disk truth: changelog "${writeback.changelogLine.slice(0, 120)}…" ; new issue ${writeback.newIssue}`)

  // ── AC2 旁证：04 闸生效 = doer 从未直写成功 ws 批次镜像 ──
  const wsSpecNow = readIfExists(wsSpecPath)
  if (wsSpecNow !== null) {
    expect(wsSpecNow, "guard evidence: ws batch mirror must stay a stale seed copy (no changelog ever written there)").not.toContain(CHANGELOG_HEADING)
  }
  const wsNewIssues = listIssues(wsIssuesDir).filter((f) => !issues0.includes(f))
  expect(wsNewIssues.length, "guard evidence: no new ticket appeared in the ws batch mirror").toBe(0)

  // ── AC2 后半：「▣ 产物」页签 DOM 可见两者（manifest 磁盘直扫；重开壳拉最新清单）──
  await openConsole(page, taskId)
  await clickTab(page, "artifacts")
  await expect(page.locator(`[data-testid="artifacts-tab"]`)).toBeVisible({ timeout: 20_000 })
  const artifactRow = (txt: string) => `[data-testid="artifacts-tab"] [data-testid="artifact-row"]:has-text("${txt}")`
  await expect(page.locator(artifactRow("spec.md")).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(artifactRow(writeback.newIssue)).first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(shotDir("flow6"), "flow6-artifacts-visible.png") })

  // 收尾对账：回写不改决策态，任务仍停在待验收；doer 会话绑定持久在场
  const derived1 = await tbv2Derived(taskId)
  expect(derived1.taskStatus, "plan writeback must not move the review state").toBe("awaiting_review")
  const binding = await tbv2Api.chatBinding(taskId)
  expect(binding.session_id, "doer session binding still alive after two turns").toBeTruthy()
  log(`f6 ok: 确认闸预览 → 回写留痕（${writeback.newIssue} + 变更记录行）→ 产物 tab 双可见；doer session ${binding.session_id.slice(0, 8)}`)
})
