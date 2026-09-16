// 验货台「核对」tab 解析层单测 — fixture 用 2026-09-16 真盘形状
// (task 91c5a975 / all-sources-2 的 spec.md + round-report.md 缩微版)。
import { describe, it, expect } from "vitest"
import {
  parsePipeTableAfter,
  parseReportTickets,
  parseSpecTickets,
  extractPathTokens,
  buildAcMatrix,
  flattenDiffFiles,
} from "../acceptance-matrix"

const SPEC_MD = `# all-sources-2 · 全源覆盖与使用路径

## User Stories

- **US1** 作为运维者，各来源在 llm_calls 各有一行。
- **US2** 作为运维者，任一来源的行都能归因使用路径。
1. 编号列表也算 In Scope 不算 US

## In Scope

1. CLI 真跑捕获——前置 probe。
2. scheduler agent job 验证打标。

## Ticket DAG

| 票 | 标题 | blockedBy |
|----|------|-----------|
| 01 | CLI 直写中心库 probe（KD4 定案） | — |
| 02 | CLI 真跑捕获 | 01 |
| 03 | 引擎域三写入点补标 | — |
| 04 | scheduler + aux 捕获 | 03 |
| 05 | e2e API 级走查 | 02,03,04 |
`

const REPORT_MD = `# Round Report · all-sources-2 · r1

## 票执行摘要

| 票 | 标题 | 状态 | 备注 |
|----|------|------|------|
| 01 | CLI probe | ✅ done | 结论回写 spec KD4；详见 issues/01 Verification Result |
| 02 | CLI 真跑捕获 | ✅ done | \`packages/cli/src/utils/usage-writer.ts\` + commands/workflow.ts 挂点；测试 usage-writer.test.ts 145 行 |
| 03 | 补标+回填 | ✅ done | server/db/schema.ts migrateV44；dao/token-usage-dao.ts |
| 04 | aux 捕获 | ⚠️ 部分 | aux-usage-capture.ts；11 处裸 sendQuery 未挂（缺口#3） |
| 05 | e2e 走查 | ✅ done | e2e-data/ 15 件 + e2e-final.db |

## 其他节
`

const DIFF_FILES = [
  { path: "packages/cli/src/utils/usage-writer.ts", status: "A", adds: 100, dels: 0 },
  { path: "packages/cli/src/commands/workflow.ts", status: "M", adds: 5, dels: 1 },
  { path: "packages/server/src/db/schema.ts", status: "M", adds: 20, dels: 0 },
  { path: "packages/server/src/db/dao/token-usage-dao.ts", status: "M", adds: 30, dels: 2 },
  { path: "packages/server/src/services/agent/aux-usage-capture.ts", status: "A", adds: 80, dels: 0 },
  { path: "packages/server/src/__tests__/usage-writer.test.ts", status: "A", adds: 145, dels: 0 },
  // rename：备注若提旧名也应锚定
  { path: "packages/server/src/services/handoff-new.ts", oldPath: "packages/server/src/services/handoff-old.ts", status: "R", adds: 1, dels: 0 },
]

describe("parsePipeTableAfter", () => {
  it("命中标题后的第一张表；无表/下个标题前无表 → null", () => {
    const rows = parsePipeTableAfter(REPORT_MD, /票执行摘要/)
    expect(rows).toBeTruthy()
    expect(rows![0]).toEqual(["票", "标题", "状态", "备注"])
    expect(rows!.length).toBe(6) // 表头 + 5 票
    expect(parsePipeTableAfter("# x\n没表\n", /x/)).toBeNull()
    expect(parsePipeTableAfter(REPORT_MD, /不存在/)).toBeNull()
  })
})

describe("票两侧解析", () => {
  it("report: 票号/claimed(✅→pass, ⚠️→warn)/备注", () => {
    const t = parseReportTickets(REPORT_MD)
    expect(t.length).toBe(5)
    expect(t[1]).toMatchObject({ ticket: "02", claimed: "pass" })
    expect(t[3]!.claimed).toBe("warn")
    expect(t[3]!.remark).toContain("缺口")
  })

  it("spec: Ticket DAG 票号 + User Stories/In Scope 列表", () => {
    const s = parseSpecTickets(SPEC_MD)
    expect(s.ticketIds).toEqual(["01", "02", "03", "04", "05"])
    // US 节内 3 行（两条 `-` + 一条编号）—— bulletLinesUnder 认 bullet 也认编号列表，节内不区分
    expect(s.userStories.length).toBe(3)
    expect(s.inScope.length).toBe(2)
  })

  it("缺表降级：report 无「票执行摘要」→ []，不抛", () => {
    expect(parseReportTickets("# 只有闲聊")).toEqual([])
    expect(parseSpecTickets("# 没有票表").ticketIds).toEqual([])
  })
})

describe("extractPathTokens", () => {
  it("反引号剥除 + 裸文件名 + 多段路径；URL 不误伤为文件", () => {
    const toks = extractPathTokens("`packages/a/b.ts` 改 + schema.sql 补 + 见 https://x.io/pull/1")
    expect(toks).toContain("packages/a/b.ts")
    expect(toks).toContain("schema.sql")
    expect(toks.some((t) => t.includes("x.io"))).toBe(false)
  })
})

describe("buildAcMatrix — 三方对账", () => {
  const spec = parseSpecTickets(SPEC_MD)
  const report = parseReportTickets(REPORT_MD)
  const m = buildAcMatrix(spec, report, DIFF_FILES)

  it("锚定计数与行状态", () => {
    expect(m.total).toBe(5)
    expect(m.degraded).toBe(false)
    const byId = new Map(m.rows.map((r) => [r.ticket, r]))
    // 票02：usage-writer.ts + commands/workflow.ts 都命中（后缀匹配 ./ 归一）
    expect(byId.get("02")!.status).toBe("anchored")
    expect(byId.get("02")!.anchoredTokens.length).toBe(2)
    // 票03：schema.ts 命中裸文件名；token-usage-dao.ts 命中全路径
    expect(byId.get("03")!.status).toBe("anchored")
    // 票01：备注只有 issues/01（无扩展名不成 token）→ 说了但无可锚 = unanchored
    expect(byId.get("01")!.status).toBe("unanchored")
    // 票05：e2e-final.db 不成锚（.db 扩展名 token 存在但 diff 没有该路径）→ unanchored
    expect(byId.get("05")!.status).toBe("unanchored")
    expect(m.anchoredCount).toBe(3)
  })

  it("rename oldPath 参与锚定", () => {
    const m2 = buildAcMatrix(
      { ticketIds: ["09"], userStories: [], inScope: [] },
      [{ ticket: "09", title: "", claimed: "pass", remark: "重构 handoff-old.ts → handoff-new.ts" }],
      DIFF_FILES,
    )
    expect(m2.rows[0]!.status).toBe("anchored")
    expect(m2.rows[0]!.matchedPaths[0]).toContain("handoff-new.ts")
  })

  it("报告有票/spec 无票 → 取并集；全无 → degraded", () => {
    const only = buildAcMatrix({ ticketIds: [], userStories: [], inScope: [] }, report, DIFF_FILES)
    expect(only.total).toBe(5)
    const none = buildAcMatrix({ ticketIds: [], userStories: [], inScope: [] }, [], [])
    expect(none.degraded).toBe(true)
    expect(none.rows).toEqual([])
  })

  it("flattenDiffFiles 展平 repos→groups→files", () => {
    const flat = flattenDiffFiles([
      { groups: [{ dir: "packages", files: DIFF_FILES.slice(0, 2) }, { dir: "(根)", files: [DIFF_FILES[2]!]}] },
    ] as never)
    expect(flat.length).toBe(3)
  })
})
