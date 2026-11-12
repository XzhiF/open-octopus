# 05 · 消耗完整统计（C7）

> 舱级完整 token/成本。复用唯一账本 llm_calls + llm_calls_costed 视图（成本查询时派生、钱不落账本）。子代理单列防双算。

## 账本与归属
- `llm_calls`：4 token 字段(input/output/cache_read/cache_creation) + model + 归属 node_execution_id/execution_id/workspace_id/session_id/instance_id/source_path。**无 cost 列**。
- 成本经 `llm_calls_costed` 视图（db/price-sql.ts）窗口匹配 billing_price_config + billing_setting(usd_to_cny/display_currency) 派生；全未定价组→NULL 不假 0。
- 聚合公式：shared/ledger.ts LEDGER_SQL / mergeLedgerParts / LlmUsageSummary。
- 子代理：`subagent_runs` 独立 token（transcript 回填），**不在 llm_calls**。

## cabinUsage 聚合（复制 sessionUsage 模式按 cabin_id）
`CabinService.usage(cabinId)`（仿 tasks-service.ts:1596 sessionUsage）：
- 舱 orchestrator 主会话 chat 行（session_id=main_session_id AND execution_id IS NULL）。
- 所有 cabin_jobs：task→chat(source/doer session, execution_id IS NULL)+executions(task_id)+aux(execution_links)；workflow→execution；subagent→subagent_runs.session_id。
- **防双算**：chat 行 execution_id IS NULL；子代理 token 单列不与 llm_calls 盲加。
- 用 aggregateLlmCallsBy + mergeLedgerParts 汇总。

## join 路径
cabins→cabin_jobs→(task: source/doer session + executions + execution_links | workflow: execution | subagent: subagent_runs.session_id)→llm_calls_costed。

## API + UI
`GET /api/cabins/:id/usage` → `{summary{totalCalls,usage,totals,modelBreakdown}, byJob[{jobId,kind,label,tokens,cost}], timing}`。
CabinUsageWindow 复用 usage-window 骨架（UsageTotalsGrid+ModelBreakdownList）+ byJob 行（task/workflow/subagent 分色）；座舱/顶栏舱级成本 chip；**10s 轮询**（无 usage SSE，同现状）。

## 实时
ledger 行在 provider result chunk 落（recordProviderResultUsage）；turn-edge/轮询刷新，不做 usage SSE。