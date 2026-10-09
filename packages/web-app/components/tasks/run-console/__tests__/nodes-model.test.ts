// 票 04 · ◆ 节点页签 —— 纯逻辑层（glyph 推导 / 排序 / 汇总 / 事件行）。
//
// 期望值全部来自独立真相：票 04 AC（✓/●/⏸/○/⏹ 语义、⏹ 而非误导性「进行中」）、
// 原型 taskboard-v2.html「◆ 节点」状态表、既有执行 wire 形状（execution.ts 的
// steps 映射注释、agent-events 路由的事件转换分支）。本模块不碰 DOM、不发请求。

import { describe, it, expect } from "vitest"
import type { AgentEvent, StepExecution } from "@/lib/types"
import {
  buildEventLines, buildNodeRows, execStateLine, extractNodeDefs,
  filterEventsForNode, isFixingWorkflow, nodeSummary,
} from "../nodes-model"

// ── fixtures（独立事实：task-fix 真实节点集 precheck/fix/fail-fast，见
//    core-pack/workflows/task-fix.yaml nodes 段）────────────────────────

const TASK_FIX_YAML = `
name: task-fix
execution_mode: serial
nodes:
  - id: precheck
    type: bash
    bash: echo ok
  - id: fix
    type: agent
    prompt: 修
  - id: fail-fast
    type: bash
`

function step(stepId: string, status: StepExecution["status"], over: Partial<StepExecution> = {}): StepExecution {
  return {
    stepId, stepName: stepId, status,
    startedAt: "2026-10-08T09:00:00Z",
    ...(over as object),
  } as StepExecution
}

describe("extractNodeDefs — YAML 顶层节点定义（声明序 = 清单序）", () => {
  it("按 YAML 声明顺序返回 id/name/type；name 缺失回落 id", () => {
    expect(extractNodeDefs(TASK_FIX_YAML)).toEqual([
      { id: "precheck", name: "precheck", type: "bash" },
      { id: "fix", name: "fix", type: "agent" },
      { id: "fail-fast", name: "fail-fast", type: "bash" },
    ])
  })

  it("节点带 name 字段时用 name（清单行是给人看的）", () => {
    const yaml = `
nodes:
  - id: dev
    name: 修复轮 · 按反馈修改
    type: agent
`
    expect(extractNodeDefs(yaml)).toEqual([{ id: "dev", name: "修复轮 · 按反馈修改", type: "agent" }])
  })

  it("loop 容器的嵌套子节点不进顶层清单（清单只列被绑流的一级节点）", () => {
    const yaml = `
nodes:
  - id: loop-a
    type: loop
    nodes:
      - id: inner
        type: bash
  - id: after
    type: bash
`
    expect(extractNodeDefs(yaml).map((d) => d.id)).toEqual(["loop-a", "after"])
  })

  it("null / 坏 YAML / 无 nodes → 空数组（调用方走 steps 兜底）", () => {
    expect(extractNodeDefs(null)).toEqual([])
    expect(extractNodeDefs("nodes: [bogus")).toEqual([])
    expect(extractNodeDefs("name: x")).toEqual([])
  })
})

describe("buildNodeRows — 状态符推导（票 04 AC1/AC5 矩阵）", () => {
  const defs = extractNodeDefs(TASK_FIX_YAML)
  const NOW = Date.parse("2026-10-08T09:05:00Z")

  it("running 执行：completed→✓ / running→●(当前) / 未起步→○，顺序 = YAML 声明序", () => {
    const rows = buildNodeRows({
      defs,
      steps: [step("precheck", "completed", { completedAt: "2026-10-08T09:01:00Z", duration: 65 }), step("fix", "running")],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows.map((r) => r.glyph)).toEqual(["✓", "●", "○"])
    expect(rows.map((r) => r.id)).toEqual(["precheck", "fix", "fail-fast"])
    expect(rows[1].isCurrent).toBe(true)
    expect(rows[0].isCurrent).toBe(false)
  })

  it("⏸：执行 paused —— 进行中的节点行是 ⏸ 而不是 ●（AC「⏸ when execution paused」）", () => {
    const rows = buildNodeRows({
      defs,
      steps: [step("precheck", "completed"), step("fix", "running")],
      execStatus: "paused",
      mode: "flow",
      now: NOW,
    })
    expect(rows[1].glyph).toBe("⏸")
    expect(rows[1].state).toBe("paused")
    expect(rows[1].isCurrent).toBe(false)
  })

  it("节点自身落库 status=paused（停在审批闸口）也推导 ⏸", () => {
    const rows = buildNodeRows({
      defs: [{ id: "gate", name: "gate", type: "approval" }],
      steps: [step("gate", "paused")],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].glyph).toBe("⏸")
  })

  it("pending_approval / pending_interaction 等人节点 = ⏸（等待放行是暂停语义）", () => {
    for (const st of ["pending_approval", "pending_interaction"] as const) {
      const rows = buildNodeRows({
        defs: [{ id: "appr", name: "appr", type: "approval" }],
        steps: [step("appr", st)],
        execStatus: st,
        mode: "flow",
        now: NOW,
      })
      expect(rows[0].glyph).toBe("⏸")
    }
  })

  it("⏹：执行 cancelled（abort/takeover 落库态）—— 进行中的节点转 ⏹(标记现场)、未执行节点也 ⏹(灰)，绝不显示 ●（AC5 反误导）", () => {
    const rows = buildNodeRows({
      defs,
      steps: [step("precheck", "completed"), step("fix", "running")],
      execStatus: "cancelled",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].glyph).toBe("✓")
    expect(rows[1].glyph).toBe("⏹")
    expect(rows[1].stopLive).toBe(true) // 它是被掐断的那个现场，UI 给粉 ⏹ + 已终止标
    expect(rows[2].glyph).toBe("⏹")
    expect(rows[2].stopLive).toBe(false)
    expect(rows.every((r) => r.glyph !== "●")).toBe(true)
  })

  it("mode=takeover：即使执行行还没刷成 cancelled（读序竞态），也按停机渲染 ⏹", () => {
    const rows = buildNodeRows({
      defs,
      steps: [step("fix", "running")],
      execStatus: "running",
      mode: "takeover",
      now: NOW,
    })
    expect(rows[1].glyph).toBe("⏹")
    expect(rows[2].glyph).toBe("⏹")
  })

  it("节点行落库 cancelled（abort 时 ExecutionLifecycle 同步写节点态）→ ⏹", () => {
    const rows = buildNodeRows({
      defs: [{ id: "fix", name: "fix", type: "agent" }],
      steps: [step("fix", "cancelled")],
      execStatus: "cancelled",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].glyph).toBe("⏹")
    expect(rows[0].stopLive).toBe(false)
  })

  it("failed/rejected → ✗；skipped → ⊘（审批打回后下游被 skip）", () => {
    const rows = buildNodeRows({
      defs: [
        { id: "a", name: "a", type: "bash" },
        { id: "b", name: "b", type: "agent" },
        { id: "c", name: "c", type: "bash" },
      ],
      steps: [step("a", "failed", { error: "exit 1" }), step("b", "rejected"), step("c", "skipped")],
      execStatus: "failed",
      mode: "flow",
      now: NOW,
    })
    expect(rows.map((r) => r.glyph)).toEqual(["✗", "✗", "⊘"])
  })

  it("loop 聚合：只有分形行 loop-a:inner-iterN（无 loop-a 整行）时，容器行按子行推导（running 优先，同执行流程图口径）", () => {
    const rows = buildNodeRows({
      defs: [
        { id: "loop-a", name: "loop-a", type: "loop" },
        { id: "after", name: "after", type: "bash" },
      ],
      steps: [
        step("loop-a:inner-iter0", "completed", { duration: 10 }),
        step("loop-a:inner-iter1", "running"),
      ],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].glyph).toBe("●")
    expect(rows[0].isCurrent).toBe(true)
    expect(rows[1].glyph).toBe("○")
  })

  it("loop 聚合：iter 后缀剥除后归拢（dev-iter0/dev-iter1 都算 dev 行）", () => {
    const rows = buildNodeRows({
      defs: [{ id: "dev", name: "dev", type: "agent" }],
      steps: [step("dev-iter0", "completed"), step("dev-iter1", "running")],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows.length).toBe(1)
    expect(rows[0].glyph).toBe("●")
  })

  it("无 YAML 定义可读（workflow_content 缺失）→ 用 steps 兜底出行，执行过的节点不至于空白", () => {
    const rows = buildNodeRows({
      defs: [],
      steps: [step("precheck", "completed", { nodeType: "bash" }), step("fix", "running", { nodeType: "agent" })],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows.map((r) => [r.id, r.glyph, r.typeBadge])).toEqual([
      ["precheck", "✓", "Bash"],
      ["fix", "●", "Agent"],
    ])
  })

  it("用时/成本列：completed 行用落库 duration（秒→格式串），未定价成本如实 —；进行中行给 ⏱ 走秒", () => {
    const rows = buildNodeRows({
      defs,
      steps: [
        step("precheck", "completed", { duration: 65, costUsd: 0.02, costComplete: true }),
        step("fix", "running", { startedAt: "2026-10-08T09:04:40Z" }),
      ],
      execStatus: "running",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].durationText).toBe("1m 5s")
    expect(rows[0].costText).toBe("$0.0200") // <$1 走 formatCost 四位档（全站唯一货币格式化器）
    expect(rows[1].durationText).toBe("⏱ 20s")
    expect(rows[1].costText).toBe("—")
    expect(rows[2].durationText).toBe("—")
  })

  it("completed 无 duration 字段时按 startedAt/completedAt 差回推（与执行流程图同口径）", () => {
    const rows = buildNodeRows({
      defs: [{ id: "a", name: "a", type: "bash" }],
      steps: [step("a", "completed", { startedAt: "2026-10-08T09:00:00Z", completedAt: "2026-10-08T09:00:30Z" })],
      execStatus: "completed",
      mode: "flow",
      now: NOW,
    })
    expect(rows[0].durationText).toBe("30s")
  })
})

describe("nodeSummary / typeBadge / isFixingWorkflow", () => {
  it("N/M done 汇总：⏹ 与 ✗ 都不计入完成", () => {
    const rows = buildNodeRows({
      defs: extractNodeDefs(TASK_FIX_YAML),
      steps: [step("precheck", "completed"), step("fix", "running")],
      execStatus: "running", mode: "flow", now: 0,
    })
    expect(nodeSummary(rows)).toEqual({ done: 1, total: 3 })
  })

  it("类型徽标：agent→Agent、bash→Bash、loop→Loop、swarm→Swarm、approval→Approval（原型徽标集）", () => {
    const rows = buildNodeRows({
      defs: [
        { id: "a", name: "a", type: "agent" },
        { id: "b", name: "b", type: "octopus_agent" },
        { id: "c", name: "c", type: "bash" },
        { id: "d", name: "d", type: "loop" },
        { id: "e", name: "e", type: "swarm" },
        { id: "f", name: "f", type: "approval" },
        { id: "g", name: "g", type: "python" },
      ],
      steps: [], execStatus: "running", mode: "flow", now: 0,
    })
    expect(rows.map((r) => r.typeBadge)).toEqual(["Agent", "Agent", "Bash", "Loop", "Swarm", "Approval", "Python"])
  })

  it("修复轮判定 = 执行行 workflow_ref 以 task-fix 结尾（05 契约：built-in/task-fix）", () => {
    expect(isFixingWorkflow("built-in/task-fix")).toBe(true)
    expect(isFixingWorkflow("built-in/matt-dev-pipeline")).toBe(false)
  })
})

describe("execStateLine — 页签头部状态语（原型 stTxt 三态 + 终止）", () => {
  it("takeover 优先：工作流已停 · 人工接管中（粉）", () => {
    expect(execStateLine({ execStatus: "cancelled", mode: "takeover", workflowRef: "built-in/matt-spec-dev" }))
      .toEqual({ tone: "pink", text: "工作流已停 · 人工接管中" })
  })

  it("暂停：已暂停，等待干预（黄）—— 修复轮暂停时纠偏优先于「推进中」播报", () => {
    expect(execStateLine({ execStatus: "paused", mode: "flow", workflowRef: "built-in/task-fix" }))
      .toEqual({ tone: "amber", text: "已暂停，等待干预" })
  })

  it("终止（非接管，如任务级中止）：绑定执行已终止（红）", () => {
    expect(execStateLine({ execStatus: "cancelled", mode: "flow", workflowRef: "built-in/matt-spec-dev" }))
      .toEqual({ tone: "red", text: "绑定执行已终止" })
  })

  it("修复轮在跑：task-fix 推进中（青）", () => {
    expect(execStateLine({ execStatus: "running", mode: "flow", workflowRef: "built-in/task-fix" }))
      .toEqual({ tone: "cyan", text: "task-fix 推进中" })
  })

  it("普通执行中：无播报（glyph 已说明一切）", () => {
    expect(execStateLine({ execStatus: "running", mode: "flow", workflowRef: "built-in/matt-spec-dev" })).toBeNull()
  })
})

describe("buildEventLines / filterEventsForNode — 节点行展开事件流", () => {
  const ev = (over: Partial<AgentEvent> & { event: string }): AgentEvent => ({ nodeId: "fix", ...over } as AgentEvent)

  it("tool_call：⚙ + 工具名 + 入参摘要；isError 转 ✗ 红行", () => {
    const lines = buildEventLines([
      ev({ event: "tool_call", toolName: "Bash", input: { command: "pnpm test" } }),
      ev({ event: "tool_call", toolName: "Edit", input: "file.ts", isError: true, result: "ENOENT" }),
    ])
    expect(lines[0].glyph).toBe("⚙")
    expect(lines[0].text).toContain("Bash")
    expect(lines[0].text).toContain("pnpm test")
    expect(lines[1].glyph).toBe("✗")
    expect(lines[1].tone).toBe("red")
  })

  it("⚑ 行 —— 既有 harness 干预数据（harness_directive，无 06 时的验证源）", () => {
    const lines = buildEventLines([ev({ event: "harness_directive", data: { directive: "别动 Dialog 尺寸逻辑" } })])
    expect(lines).toHaveLength(1)
    expect(lines[0].glyph).toBe("⚑")
    expect(lines[0].tone).toBe("pink")
    expect(lines[0].intervention).toBe(true)
    expect(lines[0].text).toContain("别动 Dialog 尺寸逻辑")
  })

  it("⚑ 行 —— 06 注入干预的两种落库形状：顶层 intervention_result（路由直通）与 agent_event 包装", () => {
    const lines = buildEventLines([
      ev({ event: "intervention_result", data: { result: "收到，已改走固定壳方案" } }),
      ev({ event: "agent_event", event_data: { type: "intervention", content: "实现方向不对" } as never }),
    ])
    expect(lines.map((l) => l.glyph)).toEqual(["⚑", "⚑"])
    expect(lines[0].text).toContain("收到，已改走固定壳方案")
    expect(lines[1].text).toContain("实现方向不对")
    expect(lines[1].intervention).toBe(true)
  })

  // 票 06 定稿形状：GET agent-events 把 resume 留痕行映射为一等 intervention 事件
  // （data={nodeId,nodeName,prompt}，见 server agent-events-intervention 契约测试）——
  // 节点页签的「该节点收到过的干预」（US11）读的就是这条。
  it("⚑ 行 —— 06 一等 intervention 事件：节点名 + 原文逐字", () => {
    const lines = buildEventLines([
      ev({ nodeId: "dev", event: "intervention", data: { nodeId: "dev", nodeName: "开发/修复", prompt: "不要动 Dialog 尺寸逻辑，直接换固定壳" } }),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].glyph).toBe("⚑")
    expect(lines[0].tone).toBe("pink")
    expect(lines[0].intervention).toBe(true)
    expect(lines[0].text).toContain("开发/修复")
    expect(lines[0].text).toContain("不要动 Dialog 尺寸逻辑，直接换固定壳")
  })

  it("⚑ 行 —— 一等 intervention 空白原文是噪声，不占行", () => {
    expect(buildEventLines([ev({ event: "intervention", data: { prompt: "   " } })])).toHaveLength(0)
  })

  it("text/bash 输出行走正文；heartbeat/status/未知 agent_event 是噪声，一行不占", () => {
    const lines = buildEventLines([
      ev({ event: "text_block", content: "先看一眼现场" }),
      ev({ event: "bash_output", content: "Tests 42 passed" }),
      ev({ event: "heartbeat", data: { state: "thinking" } }),
      ev({ event: "agent_event", event_data: { type: "status", status: "running" } as never }),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toContain("先看一眼现场")
    expect(lines[1].text).toContain("Tests 42 passed")
  })

  it("end 行按节点终态给 ✓/✗", () => {
    const lines = buildEventLines([
      ev({ event: "end", status: "completed", durationMs: 22000 }),
      ev({ event: "end", status: "failed" }),
    ])
    expect(lines[0].glyph).toBe("✓")
    expect(lines[0].text).toContain("22s")
    expect(lines[1].glyph).toBe("✗")
  })

  it("超长事件流只留尾部 limit 行（展开面板不是全量转储）", () => {
    const many = Array.from({ length: 120 }, (_, i) => ev({ event: "text_block", content: `line-${i}` }))
    const lines = buildEventLines(many, 40)
    expect(lines).toHaveLength(40)
    expect(lines[lines.length - 1].text).toContain("line-119")
  })

  it("filterEventsForNode：本体 + 作用域子行（loop-a:inner-iter1）+ iter 后缀行进来，邻位节点不进", () => {
    const events: AgentEvent[] = [
      ev({ event: "text_block", nodeId: "loop-a", content: "a-self" }),
      ev({ event: "text_block", nodeId: "loop-a:inner-iter1", content: "a-scoped" }),
      ev({ event: "text_block", nodeId: "loop-a-iter2", content: "a-iter" }),
      ev({ event: "text_block", nodeId: "loop-a2", content: "sibling-not-include" }),
    ]
    const kept = filterEventsForNode(events, "loop-a")
    expect(kept.map((e) => e.content)).toEqual(["a-self", "a-scoped", "a-iter"])
  })
})
