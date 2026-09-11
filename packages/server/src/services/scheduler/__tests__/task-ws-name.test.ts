// task-ws-name — 任务启动 workspace 命名的单一来源（2026-08-29 起）
//
// 票03 (ADR-0021) 之前，这里还有一组 WorkflowExecutor 集成用例：插一条 origin_type='task'
// 的 schedule，跑 execute()，断言 createFromSpec 收到 `task:{标题}`。那条分支随信封一起删了
// （executor 不再知道「任务」为何物），但**命名规则本身没删** —— 它现在是 ws-launch 纯函数
// 的两个调用方共用的：
//   · cron 作业 → WorkflowExecutor（naming:'cron'，名取自作业自己的 workspace_spec）
//   · 任务首建 → task-lifecycle-service.prepareWorkspace（naming:'task'，instanceKey=任务 id）
// 所以断言打在 computeTaskWsLaunchParams 上：要漂移，只能在这里漂移，两个调用方一起漂。
import { describe, it, expect } from "vitest"
import { computeTaskWsLaunchParams } from "../ws-launch"
import { taskDisplayTitle, taskWorkspaceName } from "../task-ws-name"

const FIXED = new Date(2026, 7, 29, 16, 45, 12) // 2026-08-29 16:45:12 本地时间

describe("taskDisplayTitle / taskWorkspaceName", () => {
  it("用户改过名 → 直接用 name，带 task: 前缀 + 时间尾缀", () => {
    const name = taskWorkspaceName({ name: "token计费", task_spec: '{"goal":"g"}' }, { date: FIXED })
    expect(name).toBe("task:token计费-0829-164512")
  })

  it("默认名 → 从 goal 生成 chatbot 同款标题（前 20 字 / 换行转空格）", () => {
    const goal = "实现 token 用量跟踪与费用预估：所有\nLLM 调用在 provider 层单一收口记录（含来源）"
    const title = taskDisplayTitle({ name: "Untitled task", task_spec: JSON.stringify({ goal }) })
    expect(title).toBe(goal.slice(0, 20).replace(/\n/g, " ").trim())
    expect([...title].length).toBeLessThanOrEqual(20)
  })

  it("默认名且 goal 空 → null（调用方回退 taskpool 命名）", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: '{"goal":""}' }, { date: FIXED })).toBeNull()
  })

  it("默认名且 task_spec 坏 JSON → null，不抛", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: "{oops" }, { date: FIXED })).toBeNull()
  })

  it("子单元名拼接 task:{标题}·{子单元}", () => {
    const name = taskWorkspaceName({ name: "重构网关", task_spec: "{}" }, { subName: "su-a", date: FIXED })
    expect(name).toBe("task:重构网关·su-a-0829-164512")
  })

  it("文件系统保留字符被剥离（name 即目录名）", () => {
    const name = taskWorkspaceName({ name: 'a/b\\c*d?e"f<g>h|i', task_spec: "{}" }, { date: FIXED })
    expect(name).toBe("task:abcdefghi-0829-164512")
  })
})

// ── 两式命名的分叉点 ─────────────────────────────────────────────────

const TASK_ROW = { name: "监控agent context优化", task_spec: '{"goal":"ignored goal"}' }
const cronConfig = { workspace_spec: { branch_prefix: "cron-pfx" } }

describe("computeTaskWsLaunchParams — naming:'task'（任务首建）", () => {
  it("用户改过名 → 展示名 task:{name}-{时间}，branch_prefix = taskpool-{任务 id}", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-1", naming: "task", config: cronConfig, taskRow: TASK_ROW, date: FIXED,
    })
    expect(p.workspaceName).toMatch(/^task:监控agent context优化-\d{4}-\d{6}$/)
    // branch_prefix 是 git 分支追溯用的，与展示名脱钩（旧实现挂在信封 id 上）
    expect(p.branchPrefix).toBe("taskpool-nm-task-1")
  })

  it("默认名 → 标题从 spec.goal 生成（与看板弹窗同源）", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-2", naming: "task", config: cronConfig,
      taskRow: { name: "Untitled task", task_spec: JSON.stringify({ goal: "构建 CLI 工具 cc-context-audit 来诊断上下文膨胀" }) },
      date: FIXED,
    })
    expect(p.workspaceName).toMatch(/^task:构建 CLI 工具 cc-context-\d{4}-\d{6}$/)
  })

  it("查无任务（taskRow=null）→ 回退 taskpool-{instanceKey}-{ts}，不抛", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-3", naming: "task", config: { workspace_spec: { branch_prefix: "taskpool-x" } }, taskRow: null,
    })
    expect(p.workspaceName).toMatch(/^taskpool-nm-task-3-\d{14}-[0-9a-z]{1,4}$/)
  })

  it("一 task 一分支谱系：同一任务两次起跳（跨日）branch_prefix 不变", () => {
    // 票03 的行为差：旧命名挂在信封 id 上，任务被 reopen + 重新入队就会换支，同一任务的
    // 历史分支断成两截。instanceKey 换成任务 id 后，只有展示名的时间尾缀在变。
    const a = computeTaskWsLaunchParams({
      instanceKey: "nm-task-4", naming: "task", config: cronConfig, taskRow: TASK_ROW,
      date: new Date(2026, 7, 29, 16, 45, 12),
    })
    const b = computeTaskWsLaunchParams({
      instanceKey: "nm-task-4", naming: "task", config: cronConfig, taskRow: TASK_ROW,
      date: new Date(2026, 8, 3, 9, 1, 7),
    })
    expect(b.branchPrefix).toBe(a.branchPrefix)
    expect(b.branchSuffix).not.toBe(a.branchSuffix)
  })
})

describe("computeTaskWsLaunchParams — naming:'cron'（定时作业）", () => {
  it("branch_prefix 与展示名都取自作业自己的 workspace_spec，不受任务命名影响", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "sched-9", naming: "cron", config: cronConfig, taskRow: null,
    })
    expect(p.branchPrefix).toBe("cron-pfx")
    expect(p.workspaceName).toMatch(/^cron-pfx-\d{14}-[0-9a-z]{1,4}$/)
  })

  it("date 决定 branch_suffix（YYYYMMDDHHmmss-随机尾缀，schedule_workspaces 反查依赖此格式）", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "sched-10", naming: "cron", config: cronConfig, taskRow: null, date: FIXED,
    })
    expect(p.branchSuffix.startsWith("20260829164512-")).toBe(true)
  })
})
