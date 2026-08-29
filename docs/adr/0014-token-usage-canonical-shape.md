# ADR-0014: Token 用量口径统一 — 全站规范 TokenUsage 形状，snake↔camel 只在 seam 转换

Date: 2026-08-29
Status: Accepted
Related: 承袭 commit `1da62709`（message_delta 实测口径「必须准」）; 为 ADR 未来的 C2(Pricing)/C3(UsageLedger) 铺词表

## Context

「这次执行烧了多少 token / 多少钱」是**一个事实**，但全仓有 **7 套并存的形状**、**5 个 cache 字段命名**、**每跳一次改名**。采集层（providers/engine）、持久化+出口（server/shared）、展示（web-app）三层各自换算：

- **input 有三种语义**：`result.tokens.input` 把 `cacheRead+cacheCreation` 折进 input（合并口径）；`ModelUsageEntry.inputTokens` 是纯值；`BudgetTracker` 又是 no_cache。
- **字段名族**：SDK `cache_read_input_tokens`(snake) → `MessageDeltaUsage.cacheReadTokens` → `ModelUsageEntry.cacheReadInputTokens` → DB `cache_read_tokens` → REST `totalInputTokens`/`totalInput`/`inputTokens` → web `cacheTokens`。**同名异物**（shared 与 providers 各有一个不同的 `TokenUsage`）是最大导航陷阱。
- **用户可见后果**：节点卡「运行中(turn_usage 纯值)↔REST 终态(in+cacheRead)」数字跳变；qwen 系被按 default=sonnet 价静默计费（属 C2）；僵尸口径（`swarm.ts` 死读不存在的 `tokens.cache_read`、`calibrateCosts`/`normalizeUsage`/`message_start.inputTokens` 类型残留）是弃用口径复活的路径。

deletion test：删掉「规范形状」这个概念，7 套形状立刻在原地复活 → 说明它一直在被隐式需要却从未被固化。

## Decision

**在 `@octopus/shared` 立唯一 `TokenUsage` 形状（Zod 派生），snake↔camel 只在三个 seam 的 adapter 里发生。**

1. **形状与语义**：`TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`，四字段**纯值**（input 不含 cache，对齐 `1da62709` tracker 口径）。
   - **`total` 不是字段**：需要总量必须走具名函数显式选口径（`totalTokens()` = 四项含 cache；旧「合并 total」与之数值等价）。禁止再造 `input = in+cache` 焊进口径的字段。
   - `ModelUsage = TokenUsage & { model, costUsd? }`；per-turn delta = `Partial<TokenUsage>`（直连 Anthropic 时 input/cache 可缺）。
   - **Zod 单一真相源**：`TokenUsageSchema` → `z.infer`；REST 出口挂运行时校验，SSE 热路径仅编译期。

2. **放置与半径**：规范类型在 shared（依赖方向 `shared ← providers ← engine ← server`，web 只依赖 shared 类型）。**旧 7 套全删、不留 alias** —— 别名是第七套形状的种子，`providers` 不再 re-export 任何 token 形状，消费方一律 `from '@octopus/shared'`。

3. **三个 seam（唯一允许换名的地方）**：
   - **SDK 入口**：`claude/provider.ts` result 分支把 `modelUsage`(snake/costUSD) 转 `ModelUsage[]`；`pi/token-aggregator` 同理。
   - **DB 行**：`server/db/dao/usage-mapping.ts::usageFromRow()` —— snake 列名只在此出现；DAO 之外禁止摸 `row.input_tokens`。
   - **wire 出口**：REST/SSE 统一**嵌套** `usage: TokenUsage`（弃平铺 `totalInput*`、弃 `tokensInput=in+cacheRead` 折叠、弃 node_end `tokens:{input,output}`、弃 `turn_usage.total`→改 `cumulative`）。

4. **DB 列不动**：SQLite 列保持 snake_case（改列是高风险迁移、零收益）；存量 interaction 路径写坏的「含 cache 的 input + cache 列恒 0」偏大行**不回填、不清洗**，其解释权留给 C3 的 ledger。C1 只保证**新写入**为纯值口径（含 InteractionService 写入口径修复）。历史 JSON blob（messages.metadata / schedule_executions.token_usage / harness_events.token_usage_json）在**读侧**经 `usageFromLegacyJson` 归一（存量按原值映射，不臆测拆分 cache）。

5. **口径原则不变（必须准）**：`message_start.input_tokens` 含 cache-reused、实测膨胀数千倍，仍**弃用**；运行期唯一可靠来源 = `message_delta.usage`，权威终值 = `result.modelUsage`，`LLMCallTracker` 的「保留实测 + 残差分配」`Σ===authTotal` 不变式测试原样保绿。

## Consequences

- **正向**：locality —— 改名只发生在 3 个 seam，加新出口不再发明命名；leverage —— 一个 interface 覆盖 N 调用点；节点卡跳变根除；swarm `collectFromProvider` 顺带改为 `mergeModelUsages(全部)`（修复旧只取 `[0]` 丢数）+ 删死读；web 双名防御逻辑（`input??inputTokens`、第 5 个命名 `cacheTokens`）清除。
- **代价**：横切 5 个包的大 diff（但每处机械改名 + adapter 收敛，编译器兜底，同仓 type 级 breaking 免费）。按依赖序三刀提交（① shared+providers+engine ② server ③ web-app），每刀独立 tsc 无新增 + 测试回归对齐 HEAD 基线。
- **明确不做（留给后续 ADR）**：四套价表收敛与 `estimateCost`（C2 Pricing）；跨执行 6 条 SUM 公式 / 两表对账 / cacheHitRate 三公式 / cost NULL 语义（C3 UsageLedger）；9 份前端格式化（C4）。
