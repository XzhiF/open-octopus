// task-ws-name — 任务启动 workspace 命名的单一来源（2026-08-29 起）
//
// 票03 (ADR-0021) 之前，这里还有一组 WorkflowExecutor 集成用例：插一条 origin_type='task'
// 的 schedule，跑 execute()，断言 createFromSpec 收到 `task:{标题}`。那条分支随信封一起删了
// （executor 不再知道「任务」为何物），但**命名规则本身没删** —— 它现在是 ws-launch 纯函数
// 的两个调用方共用的：
//   · cron 作业 → WorkflowExecutor（naming:'cron'，名取自作业自己的 workspace_spec）
//   · 任务首建 → task-lifecycle-service.prepareWorkspace（naming:'task'，instanceKey=任务 id）
// 所以断言打在 computeTaskWsLaunchParams 上：要漂移，只能在这里漂移，两个调用方一起漂。
//
// 2026-09-20 禁中文命名收口：产出整串必须匹配 WORKSPACE_NAME_PATTERN（名字＝目录名＝分支名
// 的原料，非 ASCII 目录是 Node cpSync 猝死的事故土壤）。取名四级：ASCII 标题 →
// phases[0].slug → djb2 短哈希 → null（调用方 taskpool 兜底）。
import { describe, it, expect } from "vitest"
import { computeTaskWsLaunchParams } from "../ws-launch"
import { taskBranchPrefix, taskDisplayTitle, taskWorkspaceName } from "../task-ws-name"
import { WORKSPACE_NAME_PATTERN } from "@octopus/shared"

const FIXED = new Date(2026, 7, 29, 16, 45, 12) // 2026-08-29 16:45:12 本地时间

describe("taskDisplayTitle / taskWorkspaceName", () => {
  it("部分中文标题 → 保住 ASCII 段，task- 前缀 + 时间尾缀，整串合法英文", () => {
    const name = taskWorkspaceName({ name: "token计费", task_spec: '{"goal":"g"}' }, { date: FIXED })
    expect(name).toBe("task-token-0829-164512")
    expect(WORKSPACE_NAME_PATTERN.test(name!)).toBe(true)
  })

  it("默认名 → 从 goal 生成 chatbot 同款标题（前 20 字 / 换行转空格）", () => {
    const goal = "实现 token 用量跟踪与费用预估：所有\nLLM 调用在 provider 层单一收口记录（含来源）"
    const title = taskDisplayTitle({ name: "Untitled task", task_spec: JSON.stringify({ goal }) })
    expect(title).toBe(goal.slice(0, 20).replace(/\n/g, " ").trim())
    expect([...title].length).toBeLessThanOrEqual(20)
  })

  it("全中文标题 + task 级主 slug（2026-09-20 批次契约）→ 主 slug 优先于 phases[0].slug", () => {
    const spec = JSON.stringify({
      format: "v4", slug: "token-metering",
      phases: [{ index: 1, slug: "auth-flow" }, { index: 2, slug: "billing" }],
    })
    const name = taskWorkspaceName({ name: "重构网关", task_spec: spec }, { date: FIXED })
    expect(name).toBe("task-token-metering-0829-164512")
  })

  it("全中文标题 + v4 phases → 取 phases[0].slug 当英文名（无主 slug 时的第二优先）", () => {
    const spec = JSON.stringify({ format: "v4", phases: [{ index: 1, slug: "copy-task-1" }] })
    const name = taskWorkspaceName({ name: "重构网关", task_spec: spec }, { date: FIXED })
    expect(name).toBe("task-copy-task-1-0829-164512")
  })

  it("全中文标题且无 slug → 稳定 djb2 短哈希（同输入两次调用逐字节一致）", () => {
    const row = { name: "重构网关", task_spec: "{}" }
    const a = taskWorkspaceName(row, { date: FIXED })
    const b = taskWorkspaceName(row, { date: FIXED })
    expect(a).toBe(b) // 确定性 —— trigger 预建与 executor 复用必须同名
    expect(a).toMatch(/^task-t[0-9a-z]{1,6}-0829-164512$/)
    expect(WORKSPACE_NAME_PATTERN.test(a!)).toBe(true)
  })

  it("默认名且 goal 空 → null（调用方回退 taskpool 命名）", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: '{"goal":""}' }, { date: FIXED })).toBeNull()
  })

  it("默认名且 task_spec 坏 JSON → null，不抛", () => {
    expect(taskWorkspaceName({ name: "Untitled task", task_spec: "{oops" }, { date: FIXED })).toBeNull()
  })

  it("子单元名带 ASCII → 拼进 core；中文子单元名靠哈希区分（同秒不撞）", () => {
    const ascii = taskWorkspaceName({ name: "重构网关", task_spec: "{}" }, { subName: "su-a", date: FIXED })
    expect(ascii).toBe("task-su-a-0829-164512")
    const c1 = taskWorkspaceName({ name: "重构网关", task_spec: "{}" }, { subName: "支付单元", date: FIXED })
    const c2 = taskWorkspaceName({ name: "重构网关", task_spec: "{}" }, { subName: "订单单元", date: FIXED })
    expect(c1).not.toBe(c2)
    expect(WORKSPACE_NAME_PATTERN.test(c1!)).toBe(true)
    expect(WORKSPACE_NAME_PATTERN.test(c2!)).toBe(true)
  })

  it("文件系统保留字符被剥离（name 即目录名）", () => {
    const name = taskWorkspaceName({ name: 'a/b\\c*d?e"f<g>h|i', task_spec: "{}" }, { date: FIXED })
    expect(name).toBe("task-abcdefghi-0829-164512")
  })
})

// ── 两式命名的分叉点 ─────────────────────────────────────────────────

const TASK_ROW = { name: "监控agent context优化", task_spec: '{"goal":"ignored goal"}' }
const cronConfig = { workspace_spec: { branch_prefix: "cron-pfx" } }

describe("computeTaskWsLaunchParams — naming:'task'（任务首建）", () => {
  it("中英混排标题 → ASCII 段成名（task-agent-context-…），branch_prefix = taskpool-{任务 id}", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-1", naming: "task", config: cronConfig, taskRow: TASK_ROW, date: FIXED,
    })
    expect(p.workspaceName).toBe("task-agent-context-0829-164512")
    expect(WORKSPACE_NAME_PATTERN.test(p.workspaceName)).toBe(true)
    // branch_prefix 是 git 分支追溯用的，与展示名脱钩（旧实现挂在信封 id 上）
    expect(p.branchPrefix).toBe("taskpool-nm-task-1")
  })

  it("默认名 → 标题从 spec.goal 生成（与看板弹窗同源），剥成 ASCII", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-2", naming: "task", config: cronConfig,
      taskRow: { name: "Untitled task", task_spec: JSON.stringify({ goal: "构建 CLI 工具 cc-context-audit 来诊断上下文膨胀" }) },
      date: FIXED,
    })
    expect(p.workspaceName).toBe("task-CLI-cc-context-0829-164512")
    expect(WORKSPACE_NAME_PATTERN.test(p.workspaceName)).toBe(true)
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

// ── taskBranchPrefix — 分支名收口（2026-09-22：告别 taskpool-{uuid}）────
describe("taskBranchPrefix — spec.branch > feat-<slug>-<YYYYMMDD> > null", () => {
  const CREATED = new Date(2026, 8, 22, 10, 0, 0).toISOString() // 2026-09-22 本地

  it("author 显式 spec.branch 最高优先（含中文/冒号先剥成 ASCII）", () => {
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ branch: "feat-my-thing", slug: "ignored" }), created_at: CREATED }))
      .toBe("feat-my-thing")
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ branch: "fix-中文-name" }), created_at: CREATED }))
      .toBe("fix-name")
  })

  it("branch 全非 ASCII（剥后为空）→ 不硬上，继续走 slug 推导→兜底链", () => {
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ branch: "重构:计费" }), created_at: CREATED })).toBeNull()
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ branch: "中文名", slug: "kept" }), created_at: CREATED }))
      .toBe("feat-kept-20260922")
  })

  it("无 branch 有主 slug → feat-<slug>-<创建日 YYYYMMDD>（主 slug 优先 phases[0].slug）", () => {
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ slug: "billing-v2", phases: [{ slug: "p1" }] }), created_at: CREATED }))
      .toBe("feat-billing-v2-20260922")
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ phases: [{ slug: "only-phase-slug" }] }), created_at: CREATED }))
      .toBe("feat-only-phase-slug-20260922")
  })

  it("无 slug 锚（仅 goal/name）→ null，调用方保留 taskpool-{taskId} 兜底", () => {
    expect(taskBranchPrefix({ task_spec: JSON.stringify({ goal: "无 slug" }), created_at: CREATED })).toBeNull()
    expect(taskBranchPrefix({ task_spec: "{坏 JSON", created_at: CREATED })).toBeNull()
  })

  it("确定性：同一行两次调用产出逐字节一致（两侧预建/复用命中前提）", () => {
    const row = { task_spec: JSON.stringify({ slug: "det" }), created_at: CREATED }
    expect(taskBranchPrefix(row)).toBe(taskBranchPrefix(row))
  })

  it("整串匹配 ^[a-zA-Z0-9_-]+$（worktree 目录名原料约束）", () => {
    const b = taskBranchPrefix({ task_spec: JSON.stringify({ slug: "runbook-mem" }), created_at: CREATED })!
    expect(WORKSPACE_NAME_PATTERN.test(b)).toBe(true)
  })
})

describe("computeTaskWsLaunchParams — naming:'task' 走 feat 分支前缀", () => {
  const CREATED = new Date(2026, 8, 22, 10, 0, 0).toISOString()
  it("有 slug 的任务 → branch_prefix = feat-<slug>-<YYYYMMDD>（不再是 taskpool-{uuid}）", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-feat", naming: "task", config: cronConfig,
      taskRow: { name: "计费重构", task_spec: JSON.stringify({ slug: "billing-v2" }), created_at: CREATED },
      date: FIXED,
    })
    expect(p.branchPrefix).toBe("feat-billing-v2-20260922")
    // 展示名照旧独立于分支前缀。
    expect(p.workspaceName).toMatch(/^task-/)
  })

  it("无 slug 锚 → 回退 taskpool-{instanceKey}（既有行为不变）", () => {
    const p = computeTaskWsLaunchParams({
      instanceKey: "nm-task-nofeat", naming: "task", config: cronConfig,
      taskRow: { name: "监控agent context优化", task_spec: '{"goal":"g"}', created_at: CREATED }, date: FIXED,
    })
    expect(p.branchPrefix).toBe("taskpool-nm-task-nofeat")
  })
})
