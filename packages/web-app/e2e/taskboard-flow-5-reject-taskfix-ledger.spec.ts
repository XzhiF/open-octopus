// packages/web-app/e2e/taskboard-flow-5-reject-taskfix-ledger.spec.ts
//
// 票 10 流⑤ —— 待验收 → 打回（写指令）→ 任务回执行中 → 节点页签显示 task-fix 真实节点集
//                → 自动回待验收 → 台账预览含 快速修改/人工干预 列。
//
// 真链路（零 mock、零 skip；R1/R5/R7）：真实 v4 任务 + 真实快轮 → awaiting_review。
// 打回走走查面真按钮（票05 单 textarea：反馈必填=task-fix 指令）→ 真 POST /acceptance
// rejected → server 恒派 built-in/task-fix（ADR-0024 单路径；workflow_chain override，
// 信封 phases[] 不动 K16）。r2 执行行 workflow_ref='built-in/task-fix' 直读 DB 为证；
// fix-feedback-r1.md 落 home 批次目录为 fs 证。
// 「节点页签显示真实节点集」的期望值不吃硬编码步数：从服务端 execution detail 的
// workflow_content（=引擎实际执行的 YAML）解析节点 id 清单，再与仓库内
// packages/core-pack/workflows/task-fix.yaml 对账（precheck→fix→fail-fast 三支真定义），
// 然后逐个断言 DOM node-row-{id} 存在且总数相等。
// 修复轮 r2 走到终态（precheck bash 真实执行；fix agent 真 provider 回合 —— 这是本流
// 唯一的 LLM 依赖点，若环境无 provider 该节点会失败，但 K3「失败归 round 层」同样把任务
// 送回待验收，本流对终态种类中立，只等终态）。回待验收后开「✓ 验收通过」的 ADR-0022
// 台账预览弹层（只预览，「再看看」关窗，不落决策）——断言 快速修改/人工干预/接管标记
// 三列在场，且 ×N 数字与 GET /round-diff 载荷（manualInterventions/quickEdits 长度）一致。
//
// ⚠ 复核名单（对最终 tip）：review-fixer 将把台账「快改」列改为排除 [takeover-edit] 轮
//   提交 —— 本流无接管轮，列存在性/口径不受影响，但列文案若随之重排需复跑确认。
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2。

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
  tbv2AcceptanceCount,
  tbv2Api,
  tbv2BootFlow,
  tbv2Derived,
  tbv2Env,
  tbv2InterventionEventCount,
  tbv2RootExecs,
  tbv2ServerAvailable,
  tbv2Until,
  waitCardColumn,
  type RootExecRow,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null

test.beforeAll(async () => {
  if (!(await tbv2ServerAvailable())) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票10 流⑤ 不允许 skip`)
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

/** 从引擎实际执行的 workflow_content（YAML 文本）解析节点 id 清单 —— 期望值吃真实定义。 */
function parseNodeIds(workflowContent: string): string[] {
  const ids: string[] = []
  const re = /^\s*-\s+id:\s*([A-Za-z0-9_-]+)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(workflowContent)) !== null) ids.push(m[1]!)
  return ids
}

async function executionDetail(wsId: string, execId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${tbv2Env().serverUrl}/api/workspaces/${wsId}/executions/${execId}`)
  if (!res.ok) throw new Error(`execution detail ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Record<string, unknown>
}

test("流⑤ 待验收 → 打回(指令) → task-fix 真实节点集 → 自动回待验收 → 台账预览三列", async ({ page }) => {
  test.setTimeout(720_000)

  // ── boot：真实快轮 → 真实待验收 ──
  handles = await tbv2BootFlow({ flow: "f5", parkSeconds: 0 })
  const taskId = handles.taskId
  const r1 = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "awaiting_review" ? d : null
  }, 240_000, "r1 never derived to awaiting_review", 1500)
  expect(r1.phaseViews[0].awaitingRound).toBe(1)
  await waitCardColumn(page, taskId, "awaiting_review")

  // ── UI：开壳 → 走查页签 → 打回（写指令，票05 单 textarea 必填闸）──
  await openConsole(page, taskId)
  await clickTab(page, "review")
  await expect(page.locator(SEL.acceptanceModal())).toBeVisible({ timeout: 30_000 })
  await page.locator(SEL.rejectOpen()).click()
  const confirm = page.locator(SEL.rejectConfirm())
  await expect(confirm).toBeDisabled() // 反馈空 → 不放行（票05 契约现场复核）
  const instruction = `E2E_TBV2 打回指令 ${handles.run}：产物缺一行收尾说明；只补文档、不动代码。`
  await page.locator(SEL.rejectFeedback()).fill(instruction)
  await expect(confirm).toBeEnabled()
  const accRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/acceptance`) && r.request().method() === "POST")
  await confirm.click()
  const accResp = await accRespP
  const accBody = (await accResp.json().catch(() => null)) as {
    next_action?: string
    dispatch?: { execution_id?: string; phase_index?: number; round_index?: number }
    error?: string
  } | null
  expect(accResp.status(), `acceptance rejected 应 200（got ${JSON.stringify(accBody)}）`).toBe(200)
  expect(accBody?.next_action).toBe("dispatched")
  expect(accBody?.dispatch?.round_index).toBe(2)

  // 真实副作用①（DB）：r2 执行行 = built-in/task-fix（05 契约「恒派 fix 路由」权威判据）
  const r2 = await tbv2Until(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.round_index === 2)
    return row ?? null
  }, 90_000, "round-2 execution row never appeared")
  expect(r2.workflow_ref, "打回恒派 built-in/task-fix").toBe("built-in/task-fix")
  // 账本一行 rejected（append-only）
  expect(tbv2AcceptanceCount(taskId), "打回落账本恰一行 rejected").toBe(1)

  // 真实副作用②（fs）：fix-feedback-r1.md 落 home 批次目录
  const homeBatch = path.join(os.homedir(), ".octopus", "tasks", taskId, handles.batchRel)
  await tbv2Until(() => (fs.existsSync(path.join(homeBatch, "fix-feedback-r1.md")) ? true : null), 30_000, "fix-feedback-r1.md missing in home batch dir")

  // ── UI：任务回执行中 → 节点页签显示 task-fix 真实节点集 ──
  const derivedR = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "running" ? d : null
  }, 60_000, "task never derived back to running with the fix round")
  expect(derivedR.phaseViews[0].currentRound).toBe(2)
  await openConsole(page, taskId)
  // fixing 形态默认落「◆ 节点」（票07 AC4 装配行）
  await expect
    .poll(async () => activeTabKey(page), { timeout: 20_000, message: "fixing 态默认页签应为 nodes" })
    .toBe("nodes")
  await expect(page.locator(SEL.nodesTab())).toBeVisible({ timeout: 20_000 })

  // 期望值吃真实定义：仓内 core-pack/workflows/task-fix.yaml 的节点集（现 = precheck/fix/fail-fast
  // 三支，但这里不硬编码 —— 解析 YAML，节点改了断言自动跟）。服务端 execution detail 的
  // workflow_content 只做软对账（含同一批 id 字符串），DOM 行集必须与 YAML 定义完全一致。
  const packedPath = path.resolve(__dirname, "..", "..", "..", "packages", "core-pack", "workflows", "task-fix.yaml")
  const packedIds = parseNodeIds(fs.readFileSync(packedPath, "utf-8"))
  expect(packedIds.length, "task-fix 真实定义至少 3 个节点").toBeGreaterThanOrEqual(3)
  const detail = await executionDetail(r2.workspace_id, r2.id)
  const servedContent = typeof detail.workflow_content === "string" ? detail.workflow_content : ""
  for (const id of packedIds) {
    if (servedContent) expect(servedContent, `execution detail content should carry node ${id}`).toContain(`id: ${id}`)
  }

  // 逐个 DOM 行存在 + 总数相等（节点行 = 真实 YAML 定义的 id 集，非虚构五步）
  for (const id of packedIds) {
    await expect(page.locator(SEL.nodeRow(id))).toBeVisible({ timeout: 30_000 })
  }
  await expect(page.locator(`${SEL.nodesTab()} [data-testid^="node-row-"]`)).toHaveCount(packedIds.length, { timeout: 20_000 })
  await expect(page.locator(SEL.nodesWfPill())).toContainText("task-fix")
  await page.screenshot({ path: path.join(shotDir("flow5"), "flow5-taskfix-nodes.png") })

  // ── 修复轮走终态 → 自动回待验收（K3 终态中立：成功或失败都回人手里）──
  const r2term = await tbv2Until<RootExecRow>(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.id === r2.id)
    return row && ["completed", "completed_with_failures", "failed", "cancelled", "rejected", "aborted", "skipped"].includes(row.status) ? row : null
  }, 480_000, "task-fix round never reached terminal (fix agent still burning?)", 3000)
  log(`f5: fix round ${r2term.id.slice(0, 8)} terminal=${r2term.status}`)
  const derivedA = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "awaiting_review" ? d : null
  }, 60_000, "after fix round the task never returned to awaiting_review", 2000)
  expect(derivedA.phaseViews[0].awaitingRound, "自动回待验收指到修复轮").toBe(2)
  await waitCardColumn(page, taskId, "awaiting_review")

  // ── 台账预览（ADR-0022 决策前弹层；只预览不落决策）──
  const diff = await tbv2Api.roundDiff(taskId, "round")
  const manualN = ((diff.manualInterventions as unknown[]) ?? []).length
  const quickN = ((diff.quickEdits as unknown[]) ?? []).length
  await openConsole(page, taskId)
  await clickTab(page, "review")
  await expect(page.locator(SEL.acceptanceModal())).toBeVisible({ timeout: 20_000 })
  await page.locator(`${SEL.acceptanceModal()} [data-acceptance-approve]`).click()
  await expect(page.locator(SEL.ledgerDialog())).toBeVisible({ timeout: 20_000 })
  // 票09 三本账三列在场（快改列口径将被 review-fixer 调整 —— 列存在性对两版语义都成立）
  await expect(page.locator(SEL.ledgerPreviewIntervention())).toContainText("人工干预")
  await expect(page.locator(SEL.ledgerPreviewQuickEdit())).toContainText("快速修改")
  await expect(page.locator(SEL.ledgerPreviewTakeover())).toContainText("接管标记")
  // ×N 与 GET /round-diff 同源（UI==API；API==DB 由干预列的权威 SQL 交叉）
  await expect(page.locator(SEL.ledgerPreviewIntervention())).toContainText(`×${manualN}`)
  await expect(page.locator(SEL.ledgerPreviewQuickEdit())).toContainText(`×${quickN}`)
  if (manualN > 0) {
    expect(tbv2InterventionEventCount(r2.id), "ledger intervention count == 票06 权威 SQL").toBe(manualN)
  }
  // 不点「确认通过」——「再看看」关窗，决策不落、账本仍 1 行
  await page.getByRole("button", { name: "再看看" }).click()
  await expect(page.locator(SEL.ledgerDialog())).toBeHidden({ timeout: 10_000 })
  expect(tbv2AcceptanceCount(taskId), "预览不落决策：账本仍只有那条 rejected").toBe(1)
  const still = await tbv2Derived(taskId)
  expect(still.taskStatus).toBe("awaiting_review")
  await page.screenshot({ path: path.join(shotDir("flow5"), "flow5-ledger-preview.png") })
  log(`f5 ok: 打回→task-fix(${packedIds.join(",")})→回待验收 r2；台账 干预×${manualN} 快改×${quickN}`)
})
