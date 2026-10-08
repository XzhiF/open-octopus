// packages/web-app/e2e/taskboard-flow-4-takeover-deliver.spec.ts
//
// 票 10 流④ —— 执行中 → ✋ 接管 → 对话改一处 → 确认交付 → 卡片进待验收 + 走查显示接管件 chip。
//
// 真链路（零 mock、零 skip；R1/R5/R7）：真实 v4 任务 + 真实触发轮（bash 落 commit 后
// sleep 停驻 —— takeover 需真引擎可 abort）。✋ 三分支框真点击选② →
// POST /takeover（abort+标记+doer 会话一发）→ 派生 phase='takeover' → 壳形态翻
// takeover（默认「💬 对话接管」）→ 真 task-doer 回合改一处（真 provider；接管轮
// = takeover_at∧¬delivered，server 自动落 [takeover-edit] commit —— 票10 review-fix
// form-aware 标记；awaiting/ready 快改仍 [quick-edit] 见流②）→「≡ 变更」实时随
// HEAD 增长（票08 第三级解析：接管轮 end 锚=当前 HEAD，接管件 commit 进本轮区间 ——
// 这条流的「统计变化」是真增长，非前端计数）。
// 「✓ 确认本 Round 交付」真点击 → POST /takeover/deliver：takeover_delivered_at +
// 逐仓 HEAD 快照进 end_commit_id → 派生落回 awaiting_review → 卡片进待验收列 →
// 走查面头部「✋ 接管件 · 自动复检未跑」chip（票08 契约，不加闸）。
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2。

import { test, expect } from "@playwright/test"
import * as path from "path"
import {
  SEL,
  activeTabKey,
  clickTab,
  gitAt,
  gitCommitCount,
  gitHead,
  log,
  logError,
  openConsole,
  shotDir,
  tbv2Api,
  tbv2BootFlow,
  tbv2DbGet,
  tbv2Derived,
  tbv2Env,
  tbv2RootExecs,
  tbv2ServerAvailable,
  tbv2Until,
  tbv2WaitRunningNode,
  waitCardColumn,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null

test.beforeAll(async () => {
  if (!(await tbv2ServerAvailable())) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票10 流④ 不允许 skip`)
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

test("流④ running → ✋ 接管 → 对话改一处（真 commit）→ 交付 → 待验收 + 接管件 chip", async ({ page }) => {
  test.setTimeout(480_000)

  // ── boot：真在跑的轮 ──
  handles = await tbv2BootFlow({ flow: "f4", parkSeconds: 600, churnEverySeconds: 0, churnRounds: 0 })
  const taskId = handles.taskId
  const { execId } = await tbv2WaitRunningNode(handles)
  const repoDir = handles.repoWorkDir()
  const startMap = JSON.parse(
    tbv2DbGet<{ start_commit_id: string }>("SELECT start_commit_id FROM executions WHERE id = ?", execId)!.start_commit_id ?? "{}",
  ) as Record<string, string>
  const startSha = startMap[handles.projName]
  expect(startSha?.length ?? 0, "start anchor recorded at claim").toBeGreaterThan(7)

  // ── ✋ 有问题 → 三分支框选 ② → 真 POST /takeover ──
  await openConsole(page, taskId)
  await expect(page.locator(SEL.railAskTakeover())).toBeVisible({ timeout: 30_000 })
  await page.locator(SEL.railAskTakeover()).click()
  await expect(page.locator(SEL.branchDialog())).toBeVisible({ timeout: 15_000 })
  await page.locator(SEL.branchOption("takeover")).click()
  const toRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/takeover`) && r.request().method() === "POST")
  await page.locator(SEL.branchGo()).click()
  const toResp = await toRespP
  expect(toResp.status(), "POST /takeover 应 200").toBe(200)

  // 真实副作用①（DB）：绑定执行被停（cancelled）+ takeover_at 落行；派生 phase='takeover'
  await tbv2Until(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.id === execId)
    return row && row.status === "cancelled" && row.takeover_at ? row : null
  }, 30_000, "takeover mark/cancel never landed on the execution row")
  const derivedT = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.phaseViews.some((p) => p.status === "takeover") ? d : null
  }, 30_000, "derived never reached phase status 'takeover'")
  expect(derivedT.taskStatus, "接管期持久态仍 running（ADR-0025 派生不落库）").toBe("running")

  // ── 壳翻 takeover 形态：默认落「💬 对话接管」──
  await expect
    .poll(async () => activeTabKey(page), { timeout: 30_000, message: "takeover 形态默认页签应为 chat" })
    .toBe("chat")
  await expect(page.locator(SEL.chatForm())).toHaveAttribute("data-chat-form", "takeover", { timeout: 20_000 })
  const chatInput = page.locator(SEL.chatInput())
  await expect(chatInput).toBeEnabled({ timeout: 30_000 })
  // 头栏接管态 pill
  await expect(page.locator(SEL.statusPill())).toHaveAttribute("data-task-modal-status", "takeover", { timeout: 20_000 })

  // ── 对话改一处：真 task-doer 回合 → 真 [takeover-edit] commit（接管轮形态标记）──
  const commitsBefore = gitCommitCount(repoDir, startSha, gitHead(repoDir))
  const marker = `E2E_TBV2_TAKEOVER_${handles.run}`
  await chatInput.fill(`把 projects/${handles.projName}/tbv2-note.md 的内容改成一行：${marker}。只改这一个文件，不要 git commit。`)
  await page.locator(SEL.chatSend()).click()
  await expect(page.locator(SEL.chatToolCard()).first()).toBeVisible({ timeout: 240_000 })

  // 真实副作用②（git 直读）：接管件 commit 落执行分支，内容真的变了
  // （review-fix 6abe16a7 分形态：接管轮 takeover_at∧¬delivered → [takeover-edit]；
  //  SSE 尾帧名 quick_edit_commit 不变 —— 下方 ×1 chip / 💬chat 行徽标断言两版语义同立）
  const qeSha = await tbv2Until(() => {
    const sha = gitHead(repoDir)
    const subj = gitAt(["log", "-1", "--pretty=%s"], repoDir)
    return subj.startsWith("[takeover-edit] ") ? sha : null
  }, 120_000, "no [takeover-edit] commit after the takeover turn") // commit 落 onTurnComplete；慢模型回合（Edit 自愈重试）可超 20s（终tip复验 run2 截图实锤），窗口对齐工具卡级 240s 量
  expect(gitAt(["show", `${qeSha}:tbv2-note.md`], repoDir)).toContain(marker)

  // 真实副作用③（UI=实时实物）：接管轮 end 锚=HEAD →「≡ 变更」统计随 HEAD 真增长
  await clickTab(page, "files")
  await expect(page.locator(SEL.filesTab())).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(SEL.quickEditChip())).toContainText("×1", { timeout: 30_000 })
  const commitsAfter = gitCommitCount(repoDir, startSha, qeSha)
  expect(commitsAfter, "the takeover-edit commit is inside the takeover round range").toBeGreaterThan(commitsBefore)
  await expect
    .poll(
      async () => {
        const txt = (await page.locator(SEL.headCommits()).first().textContent()) ?? ""
        const m = txt.match(/(\d+)\s*commits/)
        return m ? parseInt(m[1]!, 10) : null
      },
      { timeout: 15_000, message: `head commits 未追平 git=${commitsAfter}` },
    )
    .toBeGreaterThanOrEqual(commitsAfter)
  await expect(page.locator(`${SEL.host("files")} ${SEL.fileRows()}:has-text("tbv2-note.md")`).locator(SEL.quickEditBadge())).toBeVisible({ timeout: 20_000 })

  // ── ✓ 确认本 Round 交付 → 待验收 + 接管件 chip ──
  const delRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/takeover/deliver`) && r.request().method() === "POST")
  await page.locator(SEL.railDeliver()).click()
  const delResp = await delRespP
  expect(delResp.status(), "POST /takeover/deliver 应 200").toBe(200)

  // 真实副作用④（DB）：delivered 时间 + 现场 HEAD 快照进 end_commit_id（票08 实物区间权威）
  const rowD = await tbv2Until(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.id === execId)
    return row && row.takeover_delivered_at && row.end_commit_id ? row : null
  }, 30_000, "deliver never wrote takeover_delivered_at + end snapshot")
  const endMap = JSON.parse(rowD!.end_commit_id ?? "{}") as Record<string, string>
  expect(endMap[handles.projName], "交付快照 = 交付瞬间逐仓 HEAD").toBe(qeSha)

  // 真实副作用⑤（API/UI）：派生 awaiting_review + 卡片进待验收列
  const derivedA = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "awaiting_review" ? d : null
  }, 30_000, "task never derived back to awaiting_review")
  expect(derivedA.phaseViews[0].awaitingRound).toBe(1)
  await waitCardColumn(page, taskId, "awaiting_review")

  // ── 走查面：接管件 chip ──
  await openConsole(page, taskId)
  await clickTab(page, "review")
  await expect(page.locator(SEL.acceptanceModal())).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(SEL.takeoverChip())).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(SEL.takeoverChip())).toContainText("接管件")
  await page.screenshot({ path: path.join(shotDir("flow4"), "flow4-takeover-delivered.png") })
  log(`f4 ok: takeover→chat-edit(${qeSha.slice(0, 8)})→deliver；接管件 ${commitsBefore}→${commitsAfter} commits 实时进变更，卡片归待验收`)
})
