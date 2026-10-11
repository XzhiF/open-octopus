// packages/server/src/__tests__/plan-writeback-discipline.test.ts
//
// 票05（计划回写 S3）— 纪律文案契约与双份同步。seam = 「盘上的文本/纪律」：
//   1) task-fix YAML：validate 通过（isOctopusWorkflow + parseWorkflow）+ 节点 id
//      不变（run-console nodes-model 副本依赖）+ 纪律文案按 ADR-0024/0026 定稿
//      （含「计划回写 / 范围变更票 / 出口纪律 / curl 配方逐字字段」，「修订重跑 /
//      打回二分 / 二选一」死引用清零）+ .test.yaml 场景经 simulator 复跑通过。
//      （simulate 只钉拓扑不钉 prompt 文本 —— 文本断言按 tmp/pwb-notes §6 的指路
//      落在这里，engine 包本期零改动零新测试。）
//   2) 双份逐字同步（先例：clone-init-service.test.ts 'persona.md ↔ builtin-clones.ts
//      consistency'）：task-author fork persona.md ↔ 内嵌常量；SKILL.md 开发副本
//      (.claude/skills) ↔ 运行副本 (core-pack/skills)。task-doer 内嵌 persona ↔
//      运行时落盘 persona.md 的逐字钉测已在 task-doer-clone.test.ts AC1b（tmp HOME
//      init 落盘比对），不在此重复。
//   3) 作者侧活口径清扫（tracker 裁决追加）：author persona 与 SKILL 双份均不含
//      「修订重跑」「打回二分」，改为「打回单路径（ADR-0024）+ 执行期规格变更走
//      计划回写（ADR-0026）」。
//
// 期望串取自票面/ADR/GLOSSARY-MAP 定稿口径 —— 防自证：不是从实现里抄回来的。

import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import { parseWorkflow, isOctopusWorkflow } from "@octopus/shared"
import { runTestSuite, loadTestFixture, discoverTestFixture } from "@octopus/engine"
import { BUILTIN_CLONES } from "../services/agent/builtin-clones"

// ── path resolvers (dev vitest cwd = packages/server；tsup/dist 下 __dirname 兜底) ──
function repoRoot(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", ".."),
    path.resolve(process.cwd(), "..", ".."),
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "GLOSSARY-MAP.md"))) return c
  }
  return candidates[0]
}

const ROOT = repoRoot()
const FIX_YAML = path.join(ROOT, "packages", "core-pack", "workflows", "task-fix.yaml")
const FIX_TEST_YAML = path.join(ROOT, "packages", "core-pack", "workflows", "task-fix.test.yaml")
const SKILL_DEV = path.join(ROOT, ".claude", "skills", "task-author", "SKILL.md")
const SKILL_PACK = path.join(ROOT, "packages", "core-pack", "skills", "task-author", "SKILL.md")
const FORK_PERSONA = path.join(ROOT, "packages", "core-pack", "clones", "task-author", "persona.md")

/** EOL-fold（autocrlf checkout 噪音不算漂移，比对内容不比回车 —— clone-init 先例同款）。 */
const foldEol = (s: string): string => s.replace(/\r\n/g, "\n")

describe("票05: task-fix YAML 计划回写纪律契约", () => {
  const content = foldEol(fs.readFileSync(FIX_YAML, "utf-8"))

  it("validate 通过且节点拓扑不变（precheck/fix/fail-fast —— run-console 副本依赖）", () => {
    expect(isOctopusWorkflow(content)).toBe(true)
    const wf = parseWorkflow(content)
    expect(wf.name).toBe("task-fix")
    expect((wf.nodes ?? []).map((n) => n.id)).toEqual(["precheck", "fix", "fail-fast"])
  })

  it("「修订重跑」「打回二分」「二选一」死引用全文件清零（ADR-0024 单路径 · ADR-0026）", () => {
    expect(content).not.toContain("修订重跑")
    expect(content).not.toContain("打回二分")
    expect(content).not.toContain("二选一")
  })

  it("纪律含计划回写职责与出口纪律（词表定稿逐字）", () => {
    expect(content).toContain("计划回写")
    expect(content).toContain("范围变更票")
    expect(content).toContain("ready-for-agent")
    expect(content).toContain("ready-for-human")
    expect(content).toContain("Origin:")
    // 本轮不完/超范围 → 开票留档；超结构边界 → 范围变更票 —— 出口语义在场。
    expect(content).toContain("留档")
    // fix-report 结构增「计划回写」节
    expect(content).toContain("变更记录")
  })

  it("prompt 内嵌 curl 配方 —— 字段名与 routes/tasks.ts planWriteBodySchema 逐字同形", () => {
    expect(content).toContain("/plan/issues")
    expect(content).toContain('"batch"')
    expect(content).toContain('"file"')
    expect(content).toContain('"content"')
    expect(content).toContain('"reason"')
    expect(content).toContain('"source"')
    // 修复流身份线索走注入变量（matt-spec-dev 先例同款）
    expect(content).toContain("$inputs.task_id")
    expect(content).toContain("$inputs.octopus_api")
    // Windows UTF-8 暗礁警告（SKILL §2 同款纪律）
    expect(content).toContain("UTF-8")
    expect(content).toContain("--data-binary")
  })

  it("既有 .test.yaml 场景经 simulator 复跑全过（拓扑契约不削弱）", async () => {
    const wf = parseWorkflow(fs.readFileSync(FIX_YAML, "utf-8"))
    const testPath = discoverTestFixture(FIX_YAML)
    expect(testPath).toBeTruthy()
    expect(path.normalize(testPath!)).toBe(path.normalize(FIX_TEST_YAML))
    const fixture = loadTestFixture(testPath!)
    const result = await runTestSuite(wf, fixture)
    expect(result.passedCount).toBe(fixture.scenarios.length)
  })
})

describe("票05: 双份逐字同步与作者侧活口径清扫", () => {
  const authorPersona = BUILTIN_CLONES.find((c) => c.name === "task-author")!.persona

  it("task-author fork persona.md ↔ 内嵌 TASK_AUTHOR_PERSONA 逐字一致（先例同款）", () => {
    expect(foldEol(fs.readFileSync(FORK_PERSONA, "utf-8"))).toBe(foldEol(authorPersona))
  })

  it("task-author SKILL.md 开发副本 ↔ core-pack 运行副本逐字一致", () => {
    expect(foldEol(fs.readFileSync(SKILL_DEV, "utf-8"))).toBe(foldEol(fs.readFileSync(SKILL_PACK, "utf-8")))
  })

  it("author persona 活口径翻新：单路径 + 计划回写，旧二分死引用清零", () => {
    expect(authorPersona).toContain("单路径")
    expect(authorPersona).toContain("计划回写")
    expect(authorPersona).toContain("范围变更票")
    expect(authorPersona).not.toContain("修订重跑")
    expect(authorPersona).not.toContain("打回二分")
    // 「二选一」不禁 —— persona 里那处是「两条流水线二选一」技能残留禁令（与打回路由无关）。
  })

  it("SKILL.md（两份同步后）活口径翻新：单路径 + 计划回写，旧二分死引用清零", () => {
    for (const p of [SKILL_DEV, SKILL_PACK]) {
      const s = fs.readFileSync(p, "utf-8")
      expect(s).toContain("计划回写")
      expect(s).toContain("单路径")
      expect(s).toContain("范围变更票")
      expect(s).not.toContain("修订重跑")
      expect(s).not.toContain("打回二分")
      // 「人二选一路由」已清；「验证声明二选一」是无关合法词，不整体禁。
      expect(s).not.toContain("二选一路由")
    }
  })
})
