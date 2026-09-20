// 验货台「核对」tab 解析层单测 — fixture 用 2026-09-16 真盘形状
// (task 91c5a975 / all-sources-2 的 spec.md + round-report.md 缩微版)。
import { describe, it, expect } from "vitest"
import {
  parsePipeTableAfter,
  parseReportTickets,
  parseReportChangedFiles,
  parseSpecTickets,
  extractPathTokens,
  buildAcMatrix,
  buildFixResponse,
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
  const byId = new Map(m.rows.map((r) => [r.ticket, r]))

  it("锚定计数与行状态", () => {
    expect(m.total).toBe(5)
    expect(m.degraded).toBe(false)
    const byId = new Map(m.rows.map((r) => [r.ticket, r]))
    // 票02：usage-writer.ts + commands/workflow.ts 都命中（后缀匹配 ./ 归一）
    expect(byId.get("02")!.status).toBe("anchored")
    expect(byId.get("02")!.anchoredTokens.length).toBe(2)
    // 票03：schema.ts 命中裸文件名；token-usage-dao.ts 命中全路径
    expect(byId.get("03")!.status).toBe("anchored")
    // 票01：备注只有 issues/01（无扩展名不成 token）且无裸文件名命中 → silent（无路径申报）
    expect(byId.get("01")!.status).toBe("silent")
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

// ── 真实形状（aae32573 / mask-utils-1 r1，2026-09-16 走查回灌）──────────
// matt-spec-dev 实产物：表头 `| 票 | 状态 | 判据结果 |`（无标题列、备注无路径），
// 文件路径只出现在全局「Changed Files」段。旧解析在此形状上 0/3 锚且全标
// 「说了没做」—— 本组用例钉死新语义：列识别不串位、裸文件名锚、全局对账。
const REAL_SPEC = `# MaskUtils

## User Stories

- US1 maskPhone 前3后4。
- US2 maskIdCard 前3后2。
- US3 maskEmail 首尾留样。

## Ticket DAG

| 票 | 标题 | 依赖 |
|----|------|------|
| 01-maskutils-core | 实现 | — |
| 02-maskutils-tests | 测试 | 01 |
| 03-e2e-walk | 走查 | 01,02 |
`

const REAL_REPORT = `# Round Report — mask-utils-1 (r1)

## 票执行摘要（对照 issues/ 现态）

| 票 | 状态 | 判据结果 |
|---|---|---|
| 01-maskutils-core | done | compile exit 0；三方法 + final/私有构造 + 零 import；票内含 email 规则裁定 |
| 02-maskutils-tests | done | \`MaskUtilsTest\` 13 tests 全绿；模块 87 全绿；未加依赖 |
| 03-e2e-walk | done | 命令级走查 \`mvn -B -pl java-common-util test\` EXIT=0；Verification Result 段已回写 |

## Changed Files（git diff --stat origin/main...HEAD）

\`\`\`
 README.md                                  |   9 +
 java-common-util/README.md                 |  15 +
 java-common-util/src/main/.../MaskUtils.java     |  77 +
 java-common-util/src/test/.../MaskUtilsTest.java | 102 +
 4 files changed, 203 insertions(+)
\`\`\`
`

const REAL_DIFF = [
  { path: "java-common-util/README.md", status: "A", adds: 15, dels: 0 },
  { path: "java-common-util/src/main/java/com/octopus/demo/common/util/MaskUtils.java", status: "A", adds: 77, dels: 0 },
  { path: "java-common-util/src/test/java/com/octopus/demo/common/util/MaskUtilsTest.java", status: "A", adds: 102, dels: 0 },
  { path: "README.md", status: "M", adds: 9, dels: 0 },
]

describe("buildAcMatrix — 真实 3 列报告形状", () => {
  const m = buildAcMatrix(parseSpecTickets(REAL_SPEC), parseReportTickets(REAL_REPORT), REAL_DIFF, parseReportChangedFiles(REAL_REPORT))
  const byId = () => new Map(m.rows.map((r) => [r.ticket, r]))

  it("列识别不串位：状态列=done→pass，判据结果进备注，标题列缺席不吞状态", () => {
    const r01 = byId().get("01-maskutils-core")!
    expect(r01.claimed).toBe("pass")
    expect(r01.title).toBe("")
    expect(r01.remark ?? "").not.toContain("done")
    expect(r01.remark).toContain("三方法")
  })

  it("裸文件名锚：备注词精确命中 diff 文件名词干（票号 slug 不参与，防同批互撞）", () => {
    const r02 = byId().get("02-maskutils-tests")!
    expect(r02.status).toBe("anchored")
    expect(r02.matchedPaths).toEqual(["java-common-util/src/test/java/com/octopus/demo/common/util/MaskUtilsTest.java"])
    // 票01 备注只有中文判据无文件名 → silent；票03 同理
    expect(byId().get("01-maskutils-core")!.status).toBe("silent")
  })

  it("无路径申报 = silent（○），绝不判成「说了没做」", () => {
    expect(byId().get("03-e2e-walk")!.status).toBe("silent")
  })

  it("全局 Changed Files 对账：4/4 对齐，无幻影申报、无未上报文件", () => {
    expect(m.global).not.toBeNull()
    expect(m.global!.claimedFiles.length).toBe(4)
    expect(m.global!.phantom).toEqual([])
    expect(m.global!.unreported).toEqual([])
    expect(m.global!.aligned).toBe(true)
  })
})

describe("全局对账的反例", () => {
  it("报告 Changed Files 声明了 diff 没有的文件 → phantom；漏了 diff 有的 → unreported", () => {
    const report = `## 票执行摘要

| 票 | 状态 | 判据结果 |
|---|---|---|
| 01 | done | 改 schema.ts |

## Changed Files

\`\`\`
packages/server/src/db/schema.ts | 1 +
ghost/deleted.ts                 | 9 +
\`\`\`
`
    const diff = [
      { path: "packages/server/src/db/schema.ts", status: "M", adds: 1, dels: 0 },
      { path: "packages/server/other.ts", status: "A", adds: 2, dels: 0 },
    ]
    const m = buildAcMatrix(parseSpecTickets(REAL_SPEC), parseReportTickets(report), diff, parseReportChangedFiles(report))
    expect(m.global!.phantom).toEqual(["ghost/deleted.ts"])
    expect(m.global!.unreported).toEqual(["packages/server/other.ts"])
    expect(m.global!.aligned).toBe(false)
  })

  it("无 Changed Files 段 → global null（UI 不渲染全局块）", () => {
    const rpt = "## 票执行摘要\n\n| 票 | 状态 |\n|---|---|\n| 01 | done |"
    const m = buildAcMatrix(parseSpecTickets(REAL_SPEC), parseReportTickets(rpt), REAL_DIFF, parseReportChangedFiles(rpt))
    expect(m.global).toBeNull()
  })
})


// ── buildFixResponse（B 档 2026-09-20：打回→修复 回应对账）──────────────
describe("buildFixResponse — fix-report 三列表 × 实物 diff", () => {
  const FIX_MD = `# Fix Report r1
## 反馈条目表
| 反馈 | 修复动作 | 验证证据 |
|------|----------|----------|
| 端点缺字段校验 | 补 zod 校验 | packages/server/src/routes/usage.ts · vitest 3 passed |
| 文档未更新 | 改写 README | docs/ghost.md 已同步 |
| 清理死代码 | 删注释分支 | 跑过 build 无告警（无路径） |
`
  const DIFF = [{ path: "packages/server/src/routes/usage.ts", status: "M" as const, adds: 1, dels: 0 }]

  it("三行分别命中 anchored / unanchored / silent", () => {
    const rows = buildFixResponse(FIX_MD, DIFF)
    expect(rows.map((r) => r.status)).toEqual(["anchored", "unanchored", "silent"])
    expect(rows[0].matchedPaths).toEqual(["packages/server/src/routes/usage.ts"])
    expect(rows[1].unanchoredTokens).toEqual(["docs/ghost.md"])
    expect(rows[2].evidence).toContain("build")
  })

  it("无反馈条目表 → []（UI 走「点名缺表」分支，绝不猜）", () => {
    expect(buildFixResponse("# Fix Report r1\n就一句话，没表。", DIFF)).toEqual([])
  })

  it("无 diff → 全 silent（不假装对过账）", () => {
    const rows = buildFixResponse(FIX_MD)
    expect(rows.every((r) => r.status === "silent" && r.matchedPaths.length === 0)).toBe(true)
  })
})
