// packages/server/src/__tests__/plan-writeback-discipline.test.ts
//
// 票05（计划回写 S3）— 纪律文案契约与双份同步。seam = 「盘上的文本/纪律」：
//   1) 双份逐字同步（先例：clone-init-service.test.ts 'persona.md ↔ builtin-clones.ts
//      consistency'）：task-author fork persona.md ↔ 内嵌常量；SKILL.md 开发副本
//      (.claude/skills) ↔ 运行副本 (core-pack/skills)。task-doer 内嵌 persona ↔
//      运行时落盘 persona.md 的逐字钉测已在 task-doer-clone.test.ts AC1b（tmp HOME
//      init 落盘比对），不在此重复。
//   2) 作者侧活口径：author persona 与 SKILL 双份均描述「计划回写（ADR-0026）」，
//      并把打回写成「doer 在工作区原地修、不新开轮」（2026-11-23 #11 删 task-fix 后
//      的口径）；旧的「打回二分」「修订重跑」死引用保持清零。
//
// 2026-11-23：task-fix YAML 契约段随 built-in/task-fix 一起删除。

import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import { BUILTIN_CLONES } from "../services/agent/builtin-clones"

// ── path resolvers (dev vitest cwd = packages/server；tsup/dist 下 __dirname 兜底) ──
function repoRoot(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", ".."),
    path.resolve(process.cwd(), "..", ".."),
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "pnpm-workspace.yaml"))) return c
  }
  return candidates[0]
}

const ROOT = repoRoot()
const SKILL_DEV = path.join(ROOT, ".claude", "skills", "task-author", "SKILL.md")
const SKILL_PACK = path.join(ROOT, "packages", "core-pack", "skills", "task-author", "SKILL.md")
const FORK_PERSONA = path.join(ROOT, "packages", "core-pack", "clones", "task-author", "persona.md")

/** EOL-fold（autocrlf checkout 噪音不算漂移，比对内容不比回车 —— clone-init 先例同款）。 */
const foldEol = (s: string): string => s.replace(/\r\n/g, "\n")

describe("票05: 双份逐字同步与作者侧活口径清扫", () => {
  const authorPersona = BUILTIN_CLONES.find((c) => c.name === "task-author")!.persona

  it("task-author fork persona.md ↔ 内嵌 TASK_AUTHOR_PERSONA 逐字一致（先例同款）", () => {
    expect(foldEol(fs.readFileSync(FORK_PERSONA, "utf-8"))).toBe(foldEol(authorPersona))
  })

  it("task-author SKILL.md 开发副本 ↔ core-pack 运行副本逐字一致", () => {
    expect(foldEol(fs.readFileSync(SKILL_DEV, "utf-8"))).toBe(foldEol(fs.readFileSync(SKILL_PACK, "utf-8")))
  })

  it("author persona 活口径：计划回写 + 原地修（不新开轮），旧二分死引用清零", () => {
    expect(authorPersona).toContain("计划回写")
    expect(authorPersona).toContain("范围变更票")
    expect(authorPersona).toContain("不新开轮")
    expect(authorPersona).not.toContain("修订重跑")
    expect(authorPersona).not.toContain("打回二分")
    // 2026-11-23 #11：task-fix 修复轮已删除，persona 不得再引用。
    expect(authorPersona).not.toContain("task-fix")
    // 「二选一」不禁 —— persona 里那处是「两条流水线二选一」技能残留禁令（与打回路由无关）。
  })

  it("SKILL.md（两份同步后）活口径：计划回写 + 原地修，旧二分死引用清零", () => {
    for (const p of [SKILL_DEV, SKILL_PACK]) {
      const s = fs.readFileSync(p, "utf-8")
      expect(s).toContain("计划回写")
      expect(s).toContain("原地修")
      expect(s).toContain("范围变更票")
      expect(s).not.toContain("修订重跑")
      expect(s).not.toContain("打回二分")
      // 「人二选一路由」已清；「验证声明二选一」是无关合法词，不整体禁。
      expect(s).not.toContain("二选一路由")
    }
  })
})
