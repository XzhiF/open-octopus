// packages/server/src/services/knowledge/skill-draft-llm.ts
//
// skill 草案提议/改写 LLM — 生产适配器（P3 票04；case-extract-llm/archive-ingest-llm
// 同构制式，共享核 createProductionKnowledgeLLM——llm.ts）。
//
// 单测一律 fixture-mocked LLMCall（spec Testing Decisions「LLM 环节一律走 seam mock，
// 生产适配器另验离线闸」）；生产在 index.ts 注入。
// `OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` ⇒ 恒空串（离线闸）：c 路收敛为 PROPOSE_EMPTY
// （零草案）、改写收敛为 REVISE_EMPTY（文件不动）——绝不产假草案、绝不半改写。
// 模型默认 sonnet（操作流提炼+全稿改写需中等推理力）；两 env 各自可覆盖。

import { createProductionKnowledgeLLM } from "./llm"

export const SKILL_PROPOSE_MODEL_ENV = "OCTOPUS_SKILL_PROPOSE_MODEL"
export const SKILL_REVISE_MODEL_ENV = "OCTOPUS_SKILL_REVISE_MODEL"

export function createProductionSkillProposer() {
  return createProductionKnowledgeLLM({ channel: "skill-propose", modelEnv: SKILL_PROPOSE_MODEL_ENV })
}

export function createProductionSkillReviser() {
  return createProductionKnowledgeLLM({ channel: "skill-revise", modelEnv: SKILL_REVISE_MODEL_ENV })
}
