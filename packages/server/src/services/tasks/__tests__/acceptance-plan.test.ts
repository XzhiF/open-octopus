// packages/server/src/services/tasks/__tests__/acceptance-plan.test.ts
//
// 验收方案（2026-10-31 两层化）契约单测：
//   · v2：cases（1–3 条人验场景）+ checks（机器证据）；没有步骤 / 超过 3 条人层被拒；
//   · v1 兼容：pass 项转机器证据、其余转场景，id 原样保留（已有勾选仍对得上）；
//   · plan → PlaybookPayload 两段映射保住旧消费方（ledger / gate / 面板）；
//   · 人读版渲染与进度统计（只算场景）。

import { describe, it, expect } from "vitest"
import {
  AcceptancePlanSchema,
  LegacyAcceptancePlanSchema,
  convertLegacyPlan,
  parseAcceptancePlan,
  planToPlaybook,
  renderPlanMd,
  type AcceptancePlan,
  type LegacyAcceptancePlan,
} from "../acceptance-plan-types"
import { computeProgress } from "../acceptance-plan-service"

function validPlan(): AcceptancePlan {
  return {
    version: "2",
    task_id: "t-1",
    phase_index: 1,
    round_index: 2,
    generated_at: "2026-10-31T10:00:00.000Z",
    planner: "acceptance-planner",
    goal: "短语匹配查询可用",
    cases: [
      {
        id: "case:1",
        title: "输入一个短语，能查到包含它的记录",
        story: "作为用户，我输入短语能得到命中结果",
        setup: "用 runbook 起服务",
        steps: [
          { kind: "open", text: "打开搜索页", target: "http://localhost:3000/search" },
          { kind: "do", text: "输入短语", value: "quick brown" },
          { kind: "observe", text: "看到 3 条，完整短语高亮", expect: "命中项包含原始短语" },
        ],
        expect: "主路径能查到、边界不崩",
        tickets: ["01-tokenizer"],
        evidenceRefs: [{ kind: "diff", label: "新增匹配器", path: "src/PhraseMatcher.java" }],
      },
    ],
    checks: [
      {
        id: "check:unit",
        title: "短语匹配单测",
        tickets: ["01-tokenizer"],
        covers: ["短语整体命中", "大小写不敏感"],
        evidenceRefs: [{ kind: "test", label: "PhraseMatcherTest", path: "src/test/PhraseMatcherTest.java" }],
        recheck: "mvn -B -pl java-common-util -am test",
      },
    ],
    coverage: {
      stories: [{ story: "按短语查记录", case_id: "case:1" }],
      acs: [{ ac: "短语整体命中", check_ids: ["check:unit"] }],
      found: ["spec.md", "round-report.md"],
      missing: ["e2e-test-plan.md"],
    },
    warnings: [],
  }
}

function legacyPlan(): LegacyAcceptancePlan {
  return {
    version: "1",
    task_id: "t-1",
    phase_index: 1,
    round_index: 2,
    generated_at: "2026-10-30T10:00:00.000Z",
    planner: "acceptance-planner",
    goal: "短语匹配查询可用",
    items: [
      {
        id: "plan:01-tokenizer:1",
        ticket: "01-tokenizer",
        title: "分词器命中短语",
        story: "作为用户，我输入短语能得到命中结果",
        expect: "查询返回命中项且包含原始短语",
        howTo: [
          { kind: "run", text: "跑单测", command: "mvn -B -pl java-common-util -am test", expect: "exit 0" },
          { kind: "open", text: "打开查询页", path: "http://localhost:3000/search" },
        ],
        criteria: ["大小写不敏感"],
        evidenceRefs: [{ kind: "diff", label: "新增匹配器", path: "src/PhraseMatcher.java" }],
        machine: { verdict: "pass", why: "12 条回归全绿", command: "mvn -B -pl java-common-util -am test" },
      },
      {
        id: "plan:02-ui:1",
        ticket: "02-ui",
        title: "命中高亮",
        story: "",
        expect: "命中词在页面上高亮",
        howTo: [{ kind: "check", text: "人工核对高亮" }],
        criteria: [],
        evidenceRefs: [],
        machine: { verdict: "human", why: "视觉判断只能靠人" },
      },
    ],
    coverage: { found: ["spec.md", "round-report.md"], missing: ["e2e-test-plan.md"] },
    warnings: [],
  }
}

describe("AcceptancePlanSchema (v2)", () => {
  it("accepts a well-formed two-tier plan", () => {
    expect(AcceptancePlanSchema.safeParse(validPlan()).success).toBe(true)
  })

  it("rejects a case without steps (a scenario must be doable)", () => {
    const plan = validPlan()
    plan.cases[0].steps = []
    expect(AcceptancePlanSchema.safeParse(plan).success).toBe(false)
  })

  it("rejects more than 3 human cases (the whole point of the cap)", () => {
    const plan = validPlan()
    plan.cases = Array.from({ length: 4 }, (_, i) => ({ ...plan.cases[0], id: `case:${i + 1}` }))
    expect(AcceptancePlanSchema.safeParse(plan).success).toBe(false)
  })

  it("rejects zero human cases (pure tools still need one 'use it once' scenario)", () => {
    const plan = validPlan()
    plan.cases = []
    expect(AcceptancePlanSchema.safeParse(plan).success).toBe(false)
  })

  it("rejects the old v1 shape", () => {
    expect(AcceptancePlanSchema.safeParse(legacyPlan()).success).toBe(false)
  })
})

describe("legacy v1 compatibility", () => {
  it("parses v1 and splits pass items into checks, the rest into cases", () => {
    expect(LegacyAcceptancePlanSchema.safeParse(legacyPlan()).success).toBe(true)
    const parsed = parseAcceptancePlan(legacyPlan())
    expect(parsed).not.toBeNull()
    const plan = parsed!.plan
    expect(plan.version).toBe("2")
    // id 原样保留 —— 旧 checks 文件里的历史勾选仍对得上
    expect(plan.checks.map((c) => c.id)).toEqual(["plan:01-tokenizer:1"])
    expect(plan.cases.map((c) => c.id)).toEqual(["plan:02-ui:1"])
    expect(plan.checks[0].recheck).toContain("mvn")
    expect(plan.cases[0].steps[0]).toMatchObject({ kind: "observe", text: "人工核对高亮" })
    expect(parsed!.warnings[0]).toContain("旧版验收方案")
  })

  it("never returns a zero-case plan when every legacy item was machine-pass", () => {
    const legacy = legacyPlan()
    legacy.items = [legacy.items[0]]
    const { plan } = convertLegacyPlan(legacy)
    expect(plan.cases).toHaveLength(1)
    expect(plan.cases[0].id).toBe("case:legacy-review")
  })
})

describe("planToPlaybook", () => {
  it("maps cases and checks into two sections with tiers preserved", () => {
    const payload = planToPlaybook(validPlan(), { status: "ready", generated_at: "2026-10-31T10:00:00.000Z" })
    expect(payload.available).toBe(true)
    expect(payload.goal).toBe("短语匹配查询可用")
    expect(payload.plan?.status).toBe("ready")
    expect(payload.budget.steps).toBe(1)
    expect(payload.sections.map((s) => s.title)).toEqual(["你要验的", "本轮验证了什么"])

    const [cases, checks] = payload.sections
    expect(cases.items[0]).toMatchObject({
      id: "case:1",
      tier: "case",
      title: "输入一个短语，能查到包含它的记录",
      tickets: ["01-tokenizer"],
    })
    expect(cases.items[0].steps).toHaveLength(3)
    expect(cases.items[0].probe).toBeUndefined()

    expect(checks.items[0]).toMatchObject({
      id: "check:unit",
      tier: "check",
      criteria: ["短语整体命中", "大小写不敏感"],
      recheck: "mvn -B -pl java-common-util -am test",
    })
    // 「跑一下」只有在用户点名时才用；probe 命令来自 recheck
    expect(checks.items[0].probe?.command).toContain("mvn")
    expect(payload.coverage.stories).toEqual([{ story: "按短语查记录", case_id: "case:1" }])
    expect(payload.coverage.missing).toEqual(["e2e-test-plan.md"])
  })

  it("omits the evidence section when there are no machine checks", () => {
    const plan = validPlan()
    plan.checks = []
    const payload = planToPlaybook(plan, { status: "ready" })
    expect(payload.sections).toHaveLength(1)
    expect(payload.sections[0].title).toBe("你要验的")
  })
})

describe("renderPlanMd", () => {
  it("renders both layers and the scenario steps", () => {
    const md = renderPlanMd(validPlan())
    expect(md).toContain("验收方案 · Phase 1 Round 2")
    expect(md).toContain("一、你要验的（1 条场景）")
    expect(md).toContain("[打开] 打开搜索页")
    expect(md).toContain("[操作] 输入短语 — quick brown")
    expect(md).toContain("二、本轮验证了什么（1 项机器证据")
    expect(md).toContain("mvn -B -pl java-common-util -am test")
  })
})

describe("computeProgress", () => {
  it("counts decisions on cases only (machine evidence is never signed)", () => {
    const plan = validPlan()
    plan.cases.push({
      ...plan.cases[0],
      id: "case:2",
      title: "边界：不存在的短语返回空态",
    })
    const progress = computeProgress(plan, {
      version: "1",
      checks: {
        "case:1": { decision: "pass", note: "", at: "2026-10-31T10:01:00.000Z" },
        // 机器证据 id 即使被历史写进 checks，也不能算进人验进度
        "check:unit": { decision: "pass", note: "", at: "2026-10-31T10:01:00.000Z" },
      },
    })
    expect(progress).toMatchObject({
      total: 2, pass: 1, fail: 0, skip: 0, decided: 1, undecided: 1,
      next_item_id: "case:2",
    })
  })

  it("returns null next id when every case is decided", () => {
    const plan = validPlan()
    const progress = computeProgress(plan, {
      version: "1",
      checks: { "case:1": { decision: "skip", note: "下轮补", at: "x" } },
    })
    expect(progress.next_item_id).toBeNull()
    expect(progress.undecided).toBe(0)
  })
})
