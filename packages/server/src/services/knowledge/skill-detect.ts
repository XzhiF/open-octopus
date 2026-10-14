// packages/server/src/services/knowledge/skill-detect.ts
//
// skill 草案检测判据与正文模板 — P3 票04（spec 故事 15 三路中的 a/b 路纯函数面）
// + aa-fix 项8（三路之b 写侧契约：蒸馏「流程型」LLM seam 判定 prompt/解析单源）。
//
// 「判例蒸馏标记流程型」的口径演进（勘探核实 notes-aa-03 §二 → aa-fix 收口）：
// 票03 蒸馏是确定性零 LLM 的「硬约束页 + rule_ref 边」，产物上没有现成的流程型字段，
// 票04 的 b 路因此在蒸馏读面上自建词表判据（宽进）。aa-fix 项8 补齐写侧：蒸馏执行体
// （adopt→distill）按五段内容跑 LLM seam 判定并打 front-matter `procedural` 标记——
// b 路检测**优先消费标记**，词表启发式降级为标记缺席时的兜底（历史蒸馏件/无 LLM 环境）。
// 红线2/5 不破：这里**只读**判例面，草案落 drafts 区（store 单点），wiki/cases 零触碰。

import type { KcCaseCardSections } from "@octopus/shared"

/**
 * 「流程型」判据词表（运营调参入口，测试钉值；判修复+教训两段的叙事形态，
 * 不判标题词——「修复」段名恒在，判它毫无信息量）。
 * 组合形态（先…再/然后）限距防误报；纯事实陈述（保留字符、规则本身）不命中。
 */
export const SKILL_PROCEDURAL_HINTS = [
  "步骤",
  "流程",
  "依次",
  "逐个",
  "清单",
  "顺序",
  "每一步",
  "每一轮",
  "SOP",
  "checklist",
] as const

const PROCEDURAL_COMPOSITE_RE = /先[^。；\n]{0,24}(再|然后)/

/** 判据主体=修复/教训两段（现场/诊断/根因是因果叙事，流程形态沉淀在后两段）。 */
export function isProceduralCase(symptom: string, sections: Pick<KcCaseCardSections, "修复" | "教训">): boolean {
  const text = `${sections.修复 ?? ""} ${sections.教训 ?? ""}`
  if (text.trim() === "") return false
  for (const hint of SKILL_PROCEDURAL_HINTS) {
    if (text.includes(hint)) return true
  }
  return PROCEDURAL_COMPOSITE_RE.test(text)
}

// ── 蒸馏「流程型」判定 seam（aa-fix 项8·三路之b 写侧契约；纯函数单源，S1 断言入口）──

export interface ProceduralJudgeFacts {
  symptom: string
  sections: KcCaseCardSections
}

/**
 * 五段内容 → LLM 判定 prompt（spec 三路之b「按五段/教训内容」逐字；产出只取布尔，
 * 判词不入库——标记位是事实记录，叙事质量过人裁面兜底）。
 */
export function buildProceduralJudgePrompt(f: ProceduralJudgeFacts): string {
  return `# 判例「流程型」判定（蒸馏写侧）

判定这条判例的修复/教训能否沉淀为**可复用操作流程**：修复/教训段存在分步动作形态
（依次执行、固定顺序、先A后B、清单核对）⇒ 流程型；纯事实陈述（字符保留规则、
配置口径、命名约束）⇒ 陈述型。只判形态，不判内容好坏。

## 判例
symptom: ${f.symptom}
现场: ${f.sections.现场}
诊断: ${f.sections.诊断}
根因: ${f.sections.根因}
修复: ${f.sections.修复}
教训: ${f.sections.教训}

## 输出契约
只输出一个 JSON（可 \`\`\`json 围栏）：{"procedural": true} 或 {"procedural": false}`
}

/** seam 回执 → 三态（true/false=可判；undefined=坏形/空/抛错的前置归一=诚实缺席）。 */
export function parseProceduralJudgment(resp: string): boolean | undefined {
  const text = resp.trim()
  if (text === "") return undefined
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const v = (JSON.parse(text.slice(start, end + 1)) as { procedural?: unknown }).procedural
    return typeof v === "boolean" ? v : undefined
  } catch {
    return undefined
  }
}

// ── 正文模板（确定性生成；票面第 3 行渲染契约 ## 触发条件/## 步骤/## 纪律 恒在）──

/** 模板恒含的人裁纪律句（草案未经授予不生效——票面红线4 的正文级落痕）。 */
export const DISCIPLINE_LINES = [
  "- 草案未经授予不生效（授予是人裁动作，走票05 治理链）。",
  "- 执行前先按来源指针回素材包/判例对质现场，不得凭草案记忆盲跑。",
]

/** a 路：失败工具序列 → 操作流草案正文（步骤=序列逐位；相似分数进触发条件）。 */
export function skillBodyFromSequence(input: {
  selfTaskId: string
  otherTaskId: string
  seq: string[]
  score: number
}): string {
  const [first, second] = [input.selfTaskId, input.otherTaskId].sort()
  const steps = input.seq.map((t, i) => `${i + 1}. ${t}（失败点——修复动作按素材包 exec 摘录回源）`).join("\n")
  return [
    `# 重复操作流 ${first} × ${second}`,
    "",
    "## 触发条件",
    "",
    `- 任务执行 JSONL 出现与下列步骤同形的失败工具序列（跨 task 相似 ${input.score.toFixed(2)}；检测源：raw/archives 素材包 exec-jsonl-excerpt 件）。`,
    "",
    "## 步骤",
    "",
    steps,
    "",
    "## 纪律",
    "",
    ...DISCIPLINE_LINES,
    "",
  ].join("\n")
}

/** b 路：蒸馏判例 → 操作流草案正文（步骤=修复段逐句；纪律=教训段；判例/规则锚可指回）。 */
export function skillBodyFromCase(input: {
  caseId: string
  casePath: string
  symptom: string
  fix: string
  lesson: string
  ruleRef: string
}): string {
  const steps = input.fix
    .split(/[；;。]/)
    .map(s => s.replace(/^[\s\d.、）)]+/, "").trim())
    .filter(s => s !== "")
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n")
  return [
    `# ${input.symptom}`,
    "",
    "## 触发条件",
    "",
    `- 出现判例「${input.symptom}」同症状现场（源判例 ${input.caseId} · ${input.casePath} · 蒸馏规则锚 ${input.ruleRef}）。`,
    "",
    "## 步骤",
    "",
    steps === "" ? "1. （修复段未能切句——回判例原文取操作）" : steps,
    "",
    "## 纪律",
    "",
    `- 判例教训：${input.lesson}`,
    ...DISCIPLINE_LINES,
    "",
  ].join("\n")
}
