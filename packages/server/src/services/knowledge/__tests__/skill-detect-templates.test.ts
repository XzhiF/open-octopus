// packages/server/src/services/knowledge/__tests__/skill-detect-templates.test.ts
//
// P3 票04 — 检测 b 路「流程型」判据 + 草案正文模板（S1 纯函数面；spec 故事 15）。
//
// 「判例蒸馏标记流程型」的落地口径（勘探核实：票03 蒸馏是确定性零 LLM 的
// 硬约束页 + rule_ref 边，**没有**现成的流程型字段——见 notes-aa-03 §二）。
// 故本票的检测 = 在票03 的 rule_ref/蒸馏产物**读面**上自建「流程型」判据
// （宽进：五段里修复/教训含操作流程形态即候选，草案卡人裁=严出）。
// 模板函数确定性生成 SKILL.md 正文（## 触发条件/## 步骤/## 纪律 三段恒在，
// 票面第 3 行卡渲染契约）；内容质量不进断言，结构与时序进（spec Testing Decisions）。

import { describe, it, expect } from "vitest"
import { SKILL_PROCEDURAL_HINTS, isProceduralCase, skillBodyFromCase, skillBodyFromSequence } from "../skill-detect"

const PROCEDURAL_CASE = {
  symptom: "Git Bash ref 冒号被转成路径",
  sections: {
    现场: "ref 'a:b' 变成了目录 a/b。",
    诊断: "MSYS 路径转换吃冒号。",
    根因: "转换规则覆盖盘符后冒号。",
    修复: "处理步骤：先用 MSYS_NO_PATHCONV=1 前缀重试，再核对 ref；按顺序执行不得颠倒。",
    教训: "凡是带冒号的参数，逐条过一遍转换清单。",
  },
}

const DECLARATIVE_CASE = {
  symptom: "Windows 盘符冒号是保留字符",
  sections: {
    现场: "路径拼接报错。",
    诊断: "冒号被当成分隔符。",
    根因: "Windows 文件系统保留字符规则。",
    修复: "改用正斜杠路径。",
    教训: "Windows 下冒号是保留字符（2026-09-05 复现确认）。",
  },
}

describe("流程型判据（票04 b 路·读票03 rule_ref 边）", () => {
  it("判据词表钉值（运营调参入口，漂移即红）", () => {
    expect(SKILL_PROCEDURAL_HINTS.length).toBeGreaterThan(0)
    expect(SKILL_PROCEDURAL_HINTS).toContain("步骤")
    expect(SKILL_PROCEDURAL_HINTS).toContain("流程")
  })

  it("修复/教训段带操作流程形态 ⇒ 流程型；纯事实陈述 ⇒ 非流程型（判据只看叙事形，不看标题词）", () => {
    expect(isProceduralCase(PROCEDURAL_CASE.symptom, PROCEDURAL_CASE.sections)).toBe(true)
    expect(isProceduralCase(DECLARATIVE_CASE.symptom, DECLARATIVE_CASE.sections)).toBe(false)
    // 空段/缺段容错不炸
    expect(isProceduralCase("x", { 现场: "", 诊断: "", 根因: "", 修复: "", 教训: "" })).toBe(false)
  })
})

describe("草案正文模板（票面第 3 行渲染契约：触发条件/步骤/纪律）", () => {
  it("sequence 模板：步骤=失败工具序列逐位编号；触发条件指回来源 task 对；纪律恒含「未经授予不生效」人裁句", () => {
    const body = skillBodyFromSequence({
      selfTaskId: "task-a",
      otherTaskId: "task-b",
      seq: ["read", "bash", "edit", "bash"],
      score: 1,
    })
    expect(body).toContain("## 触发条件")
    expect(body).toContain("## 步骤")
    expect(body).toContain("## 纪律")
    expect(body).toContain("1. read")
    expect(body).toContain("4. bash")
    expect(body).toContain("task-a")
    expect(body).toContain("task-b")
    expect(body).toContain("未经授予不生效")
  })

  it("case 模板：触发条件=判例症状；步骤=修复段逐句；纪律=教训段；判例与规则锚可指回", () => {
    const body = skillBodyFromCase({
      caseId: "case-msys",
      casePath: "cases/2026-10-12-case-msys.md",
      symptom: PROCEDURAL_CASE.symptom,
      fix: PROCEDURAL_CASE.sections.修复,
      lesson: PROCEDURAL_CASE.sections.教训,
      ruleRef: "oct-001",
    })
    expect(body).toContain("## 触发条件")
    expect(body).toContain(PROCEDURAL_CASE.symptom)
    expect(body).toContain("## 步骤")
    expect(body).toContain("MSYS_NO_PATHCONV=1")
    expect(body).toContain("## 纪律")
    expect(body).toContain("逐条过一遍转换清单")
    expect(body).toContain("case-msys")
    expect(body).toContain("oct-001")
    expect(body).toContain("未经授予不生效")
  })
})
