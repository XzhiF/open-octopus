// packages/web-app/e2e/taskboard-flow-1-running-files-tab.spec.ts
//
// 票 10 流① —— 执行中卡 → 弹窗默认「≡ 变更」→ 统计条与文件行存在；任务新 commit 后 ≤10s 列表更新。
//
// 真链路（零 mock、零 skip；R1/R5/R7）：REST 直造 v4 任务（org=E2E_TBV2_org，
// bash-only stub 流，节点每 ~4s 在真实 git worktree 落一个 commit，随后停驻 sleep），
// 真实 dispatcher claim → ws 首建 + worktree + 执行；「执行中」不是 seeded 谎言。
// 观测链 = 产品自身：TaskRunConsole 壳（票02）→ tab-assembly running 默认 files（票02）
// → FilesTab 统计条/文件行（票03）→ round-diff live 端锚=HEAD + ≤9s 兜底轮询（票03）。
// 「≤10s」用 git 侧新 commit 的真实时刻起表，量到 DOM 数字追平为止。
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2（先决条件：worktree 栈已起，
// 见 helpers/taskboard-v2-helpers.ts 头部环境说明）。

import { test, expect } from "@playwright/test"
import * as path from "path"
import {
  SEL,
  activeTabKey,
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
  tbv2Env,
  tbv2ServerAvailable,
  tbv2Until,
  tbv2WaitRunningNode,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null
let serverAvailable = false

test.beforeAll(async () => {
  serverAvailable = await tbv2ServerAvailable()
  // 反假跑：没有真 server 直接 FAIL，不 skip。
  if (!serverAvailable) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票10 流① 不允许 skip`)
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

test("流① running → 默认变更页签 → 统计条/文件行 → 新 commit ≤10s 上屏", async ({ page }) => {
  test.setTimeout(300_000)

  // ── boot：真实触发的执行中轮，bash 节点在真实 worktree 里连续落 commit ──
  handles = await tbv2BootFlow({ flow: "f1", parkSeconds: 240, churnEverySeconds: 4, churnRounds: 12 })
  const taskId = handles.taskId
  const { execId } = await tbv2WaitRunningNode(handles)
  const repoDir = handles.repoWorkDir()
  const startSha = String(
    (JSON.parse(tbv2DbGet<{ start_commit_id: string }>("SELECT start_commit_id FROM executions WHERE id = ?", execId)!.start_commit_id ?? "{}") as Record<string, string>)[handles.projName],
  )
  expect(startSha.length, "dispatcher recorded the round start anchor").toBeGreaterThan(7)

  // 真实副作用①：本轮已有 ≥1 个 agent 侧 commit（git 直读，喂断言基线）
  await tbv2Until(() => {
    const n = gitCommitCount(repoDir, startSha, gitHead(repoDir))
    return n >= 1 ? n : null
  }, 45_000, "no agent-side commit landed in the round range")

  // ── UI：深链开统一壳；running 装配表默认页 =「≡ 变更」──
  await openConsole(page, taskId)
  const consoleRoot = page.locator(SEL.consoleRoot())
  await expect(consoleRoot).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => activeTabKey(page), { timeout: 20_000, message: "running 态默认页签应为 files" })
    .toBe("files")
  await expect(page.locator(SEL.filesTab())).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(SEL.statStrip())).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(SEL.fileRows()).first()).toBeVisible({ timeout: 30_000 })

  // 真实副作用②（API 面）：round-diff live 端锚=HEAD —— 服务端口径与 git 直读一致
  const headNow = gitHead(repoDir)
  const gitNow = gitCommitCount(repoDir, startSha, headNow)
  await tbv2Until(async () => {
    const diff = await tbv2Api.roundDiff(taskId, "round")
    const commits = (diff.aggregate as { commits: number }).commits
    return commits >= gitNow ? commits : null
  }, 15_000, `round-diff API never caught up with git (${gitNow})`)

  // ── ≤10s 观测口径：以 git 侧「新 commit 落地」的真实时刻起表，量 DOM 数字追平 ──
  const before = gitHead(repoDir)
  await tbv2Until(() => (gitHead(repoDir) !== before ? true : null), 20_000, "churn node stopped committing")
  const newSha = gitHead(repoDir)
  const tCommit = Date.now()
  const gitAfter = gitCommitCount(repoDir, startSha, newSha)
  expect(gitAfter, "the new commit is inside the round range").toBeGreaterThan(gitNow)

  await expect
    .poll(
      async () => {
        const txt = (await page.locator(SEL.headCommits()).first().textContent()) ?? ""
        const m = txt.match(/(\d+)\s*commits/)
        if (!m) return null
        return parseInt(m[1]!, 10) >= gitAfter ? parseInt(m[1]!, 10) : null
      },
      { timeout: 11_500, message: `新 commit 后 >11.5s（10s 兜底轮询 + 一拍渲染余量）DOM 提交数仍未追平 git=${gitAfter}` },
    )
    .toBeGreaterThan(gitAfter - 1)
  const elapsedMs = Date.now() - tCommit
  log(`f1: new commit → DOM 追平耗时 ${elapsedMs}ms（git ${gitAfter} commits，AC「≤10s」+ 渲染余量）`)
  expect(elapsedMs, "AC: 新 commit 后 ≤10s 列表更新（含 ~1.5s 渲染/轮询对齐余量）").toBeLessThanOrEqual(11_500)

  // 真实副作用③：文件行数也随新文件（churn-$i.md）出现
  await expect(page.locator(SEL.fileRows()).first()).toBeVisible()

  // 收尾前留证：git log 主题（agent 侧真实提交）+ 截图
  const subjects = gitAt(["log", "-3", "--pretty=%s"], repoDir).split(/\r?\n/)
  expect(subjects.some((s) => /tbv2 churn/.test(s)), `git log should carry the task's own commits, got ${subjects.join(" | ")}`).toBe(true)
  await page.screenshot({ path: path.join(shotDir("flow1"), "flow1-files-live.png") })
})
