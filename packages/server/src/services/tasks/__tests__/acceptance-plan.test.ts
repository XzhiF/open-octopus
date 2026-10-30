// packages/server/src/services/tasks/__tests__/acceptance-plan.test.ts
//
// 验收方案（2026-10-30 AI-native）契约单测：
//   · Zod schema 把「没有怎么验 / 没有机器建议」的方案拒之门外；
//   · plan → PlaybookPayload 映射保住旧消费方（ledger / gate / 旧面板）；
//   · 人读版渲染与进度统计。

import { describe, it, expect } from "vitest"
import {
  AcceptancePlanSchema,
  planToPlaybook,
  renderPlanMd,
  type AcceptancePlan,
} from "../acceptance-plan-types"
import { computeProgress } from "../acceptance-plan-service"

function validPlan(): AcceptancePlan {
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

describe("AcceptancePlanSchema", () => {
  it("accepts a well-formed plan", () => {
    const res = AcceptancePlanSchema.safeParse(validPlan())
    expect(res.success).toBe(true)
  })

  it("rejects an item without howTo (怎么验 is the point of the plan)", () => {
    const plan = validPlan()
    plan.items[0].howTo = []
    const res = AcceptancePlanSchema.safeParse(plan)
    expect(res.success).toBe(false)
  })

  it("rejects an item without machine advice", () => {
    const plan = validPlan() as unknown as Record<string, unknown>
    const items = plan.items as Array<Record<string, unknown>>
    delete items[0].machine
    const res = AcceptancePlanSchema.safeParse(plan)
    expect(res.success).toBe(false)
  })

  it("rejects more than 8 items (one sitting budget)", () => {
    const plan = validPlan()
    plan.items = Array.from({ length: 9 }, (_, i) => ({ ...plan.items[0], id: `plan:x:${i + 1}` }))
    expect(AcceptancePlanSchema.safeParse(plan).success).toBe(false)
  })
})

describe("planToPlaybook", () => {
  it("maps items into the legacy payload shape (ids + machine fields preserved)", () => {
    const payload = planToPlaybook(validPlan(), { status: "ready", generated_at: "2026-10-30T10:00:00.000Z" })
    expect(payload.available).toBe(true)
    expect(payload.goal).toBe("短语匹配查询可用")
    expect(payload.plan?.status).toBe("ready")
    const items = payload.sections.flatMap((s) => s.items)
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe("plan:01-tokenizer:1")
    expect(items[0].ticket).toBe("01-tokenizer")
    expect(items[0].machine?.verdict).toBe("pass")
    expect(items[0].howTo).toHaveLength(2)
    // 「跑一下」按钮的 probe 命令从 howTo.run 派生
    expect(items[0].probe?.command).toContain("mvn")
    expect(items[1].probe).toBeUndefined()
    expect(payload.coverage.missing).toEqual(["e2e-test-plan.md"])
  })
})

describe("renderPlanMd", () => {
  it("renders every item with pass criteria and how-to", () => {
    const md = renderPlanMd(validPlan())
    expect(md).toContain("验收方案 · Phase 1 Round 2")
    expect(md).toContain("分词器命中短语")
    expect(md).toContain("mvn -B -pl java-common-util -am test")
    expect(md).toContain("机器只建议")
  })
})

describe("computeProgress", () => {
  it("counts decisions and points at the next undecided item", () => {
    const plan = validPlan()
    const progress = computeProgress(plan, {
      version: "1",
      checks: {
        "plan:01-tokenizer:1": { decision: "pass", note: "", at: "2026-10-30T10:01:00.000Z" },
      },
    })
    expect(progress).toMatchObject({
      total: 2, pass: 1, fail: 0, skip: 0, decided: 1, undecided: 1,
      next_item_id: "plan:02-ui:1",
    })
  })

  it("returns null next id when everything is decided", () => {
    const plan = validPlan()
    const progress = computeProgress(plan, {
      version: "1",
      checks: {
        "plan:01-tokenizer:1": { decision: "pass", note: "", at: "x" },
        "plan:02-ui:1": { decision: "skip", note: "下轮补", at: "x" },
      },
    })
    expect(progress.next_item_id).toBeNull()
    expect(progress.undecided).toBe(0)
  })
})
