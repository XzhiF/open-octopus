# ADR-0016: UsageLedger — 总量唯一账本、三态费用、公式单源（写 9→1，读 41→1，web 14→0）

Date: 2026-08-30
Status: Accepted
Related: 承接 ADR-0014（C1 形状）/ ADR-0015（C2 计价，其「移交 C3」两笔在本篇兑现）；为 C4（格式化）提供 `—/≈/$` 三态数据源

## Context

C1 统一了单次执行的用量形状，C2 统一了「值多少钱」的查价，但「**加起来等于多少**」仍无法无天：

- **写侧 9 个入口**：node_token_usages 三条路径各持裸 SQL（UPSERT/裸 INSERT/UPSERT+harness），冲突语义三分；cost 兜底不对称（llm_calls 写侧有 `estimateCost`、node 表没有）；harness 恒 NULL（"deferred to billing layer" 无人接手）；两处 upsert 把 `NULL+NULL` 焊成 `0`（C2 假 0 病在写侧的表亲）。
- **读侧 41+ 条聚合公式**：总 tokens 三口径并存（四字段和 / in+out / cacheRead 折进 input）；cost NULL 两套语义（leaderboard 系 5 处「null+costComplete」vs 其余 43 处「COALESCE→0/WHERE 过滤/裸 SUM」）；cacheHitRate 4 个变体、同名指标量纲差 100 倍；dashboard `all_time_cost` 跨两表直接相加；archive 冻结行一行内三源交叉。
- **两表真相漂移**：总量一度从 llm_calls SUM——它受 `llm_calls_persist` flag 门控（关=总量 0）、harness 不写它、与 node 表 cost 兜底不对称。运行中（llm_calls 源）↔ 完成（node 表源）数字跳变。
- **web 14+ 处重算**：C1「total 不是字段」的代价——server 不下发总量，前端自己加，加出三套口径和 6 份重复实现（同屏两个"总量"互不相等）；跨执行合并的加权 hitRate 有真 bug（权重 `||1`、分母 `||0`）。

deletion test：删掉「账本」概念，41 条公式在原地复活，两表继续各说各话。

## Decision

1. **收敛半径 = 写 + 读 + wire**（Q1）。打分公式（healthScore 族）只换口径输入；archive 只改生成端；存量假数不回填。
2. **总 tokens 唯一定义 = `totalTokens()` 四字段和**（含 cache，Q2）。`in+out` 与 `in+cacheRead` 两种半口径全站废除（含 6 处 UI 折叠显示——cache 由 ⚡/🗡 分项徽标承载）。
3. **cost NULL 语义 = leaderboard B 类升全站规范**（Q3）：`LedgerCost = { usd: number|null, complete: boolean }`。全未定价 → `null`（UI「—/未定价」）；部分定价 → 已知部分和 + `complete:false`（UI「≈」）。43 处 A 类（COALESCE→0 / WHERE IS NOT NULL / 裸 SUM 当 0）全部改走 ledger；写侧两处 upsert 焊接改「双 NULL 保 NULL」。明细曲线（timeSeries、图表轴）允许 `?? 0` 但必须带 `// ledger-ok:` 标记（已知消费曲线口径，非总量出口）。
4. **两表职责**（Q4）：`node_token_usages` = 总量唯一账本（所有「总 tokens/总费用」只从它聚合）；`llm_calls` = call 级明细，只服务钻取（byModel/byNode 明细、时间序列、单 call 列表），`llm_calls_persist` flag 保留（只关明细）。harness/interaction/engine 三路 cost 写侧兜底对称化（`ledgerCostUsd` 单函数：given → 价表估算 → NULL）。
5. **cacheHitRate 唯一公式** = `cacheRead/(input+cacheRead)` ∈ 0–1，分母 0 → `null`（Q5）。V1（cache/total 错名）、V3（tokenEfficiency 另立）、V4（前端带 bug 加权）全删；跨执行合并走 `mergeLedgerParts`（分母加权天然正确）。
6. **模块形状**（Q6）：公式住 `shared/ledger.ts`（JS 函数 + `LEDGER_SQL` 片段常量）；server 侧 `TokenUsageDAO.recordNodeUsage` 为 node 表唯一写入口（UPSERT 累加 + `source: node|interaction|harness` 参数 + cost 三态决策）；DAO 读侧聚合必须用 `LEDGER_SQL` 拼接。**金表测试**钉 SQL ≡ JS 同数据集逐位相等，防双定义漂移。
7. **wire**（Q7）：`totals: { tokens, cost{usd,complete}, cacheHitRate }` 挂 execution_metrics(SSE) / observability summary / llm-calls aggregates 三主出口；observability byNode/byModel 行级 `tokens` 由 server 输出。旧平铺 `totalCostUsd/totalTokens/两字段口径` 全删不留 alias。
8. **配套**（Q8）：archive 生成端单源 ntu（model_breakdown/total_cost 不再取 llm_calls，context-builder 双表回退链删除，prompts 对 LLM 说 unpriced）；`/10` 魔数 → `COST_EFFICIENCY_BASELINE_USD` 具名 + 未定价维度 null → healthScore **权重重归一**；schedule/harness_events/messages.metadata 三处 JSON **定性为场景快照非账本，不收敛**；source 列写清三值仅作诊断键。
9. **防复活**：`ledger-revival-gate.test.ts` 扫描 server 生产代码，禁 ledger 外的 `COALESCE(SUM(cost),0)` / 两字段折叠 SUM / `cost_usd IS NOT NULL` 聚合过滤 / 未标记的 JS `cost ?? 0` 求和；并锁 node_token_usages 的 INSERT 语句全仓只存在于 `token-usage-dao.ts` 一处。

## Consequences

- **正向**：locality——「总量」的定义改动只发生 shared/ledger.ts 一个文件；leverage——`aggregateByExecution` 一个函数覆盖 5 个消费端；运行中↔完成跳变、flag 关闭变 0、两表 cost 不对称、V4 加权 bug 结构根除；端到端对账不变式（SSE≡steps≡summary≡live 四路）首次成为可测试事实。
- **代价与可见变化**（纠错性）：qwen 类工作区的总费用从假数变「—/≈」；节点徽章总 token 数字微增（cache 计入）；成本排行榜里部分定价组从「隐藏」变「≈ 部分和」；命中率数值换轨（旧 0-100 与 cache/total 口径作废）。
- **已知边界**：明细分解（byModel/byNode 行、时间序列）仍源自 llm_calls 钻取口径，与 ntu 账本在 flag 关闭时允许「明细缺失但总量正确」；ntu 重跑累加的 cost 在「先未定价后补价」场景下部分和偏低，由 `complete` 标志表达；`findThinkingOutputRatio` 把 cache 列挪用为 thinking 代理语义，留待 harness 域自行改名。
- **C4 依赖已就位**：`—/≈/$` 三态数据源就是 `totals.cost`，9 份格式化器收敛时直接消费。
