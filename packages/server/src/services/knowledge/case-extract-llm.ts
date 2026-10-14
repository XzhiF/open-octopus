// packages/server/src/services/knowledge/case-extract-llm.ts
//
// 判例五段草案 LLM — 生产适配器（P3 票03；archive-ingest-llm/curator-llm 同构制式，
// 共享核 createProductionKnowledgeLLM——llm.ts）。
//
// 单测一律 fixture-mocked LLMCall（spec Testing Decisions「LLM 环节一律走 seam mock，
// 生产适配器另验离线闸」）；生产在 index.ts 注入本函数。
// `OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` ⇒ 恒空串（离线闸）；空串由 CaseExtractService
// 收敛为 EXTRACT_EMPTY skipped = 零草案零入队零落盘——绝不产假判例。
// 模型：默认 sonnet（报错序列→五段因果链提炼需中等推理力）；`OCTOPUS_CASE_EXTRACT_MODEL` 覆盖。

import { createProductionKnowledgeLLM } from "./llm"

export const CASE_EXTRACT_MODEL_ENV = "OCTOPUS_CASE_EXTRACT_MODEL"

export function createProductionCaseExtractor() {
  return createProductionKnowledgeLLM({ channel: "case-extract", modelEnv: CASE_EXTRACT_MODEL_ENV })
}
