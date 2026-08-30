# ADR-0015: Pricing 统一 — 单一价表 seam，无 default 兜底，未定价诚实为 NULL

Date: 2026-08-30
Status: Accepted
Related: 承接 ADR-0014（C1 TokenUsage 形状统一，本篇处理其「明确不做」中的 Pricing）；为 C3 UsageLedger 留 analytics 语义移交

## Context

C1 统一了「烧了多少 token」的形状，本篇统一「值多少钱」。此前全仓 **4 个价源并存**：

1. `providers/llm-call-tracker.ts::MODEL_PRICING`（USD/token 写法 `3/1e6`）——含 **`default` = sonnet 价**：任何查不到的模型（qwen 系全部）被按 $3/$15 **静默假记账**，`llm_calls.cost_usd` 存量全是假数；
2. `shared/config/model-alias.ts::CustomModelSchema.cost`（models.yaml，USD/MTok）——**定义了但从未接线计价**，纯装饰；
3. `pi/pi-sdk-adapter.ts::EXTRA_PROVIDERS`——dashscope 四模型硬编码**全 0 价**，pi SDK 按 0 算出假 $0；
4. SDK 内置价表——Claude 路径的权威来源，但**对不认识的模型（代理 qwen）返回 `costUSD: 0`**，而下游一律用 `?? ` 兜底，0 不是 nullish → 假 0 吞掉一切补价机会。

另一个伪概念是 measured vs estimated：Anthropic/pi 返回的只有 token 数，**系统里不存在账单实测 cost**——所有 cost 都是「某个价表算出来的估算」，measured|estimated 是假二分。

deletion test：删掉「统一价表」概念，4 个价源立刻在原地各自复活。

## Decision

1. **单一计价模块 `shared/src/pricing.ts`**，单位统一 **USD/MTok**（与 models.yaml / pi SDK / 厂商官网一致）。接口：`priceFor(model): PricingTier | null` + `estimateCost(usage, tier): number | null`。**无 default 兜底**——查不到价 = `null` = 未定价。
2. **价表 v1 只收 Claude 4 档**（照搬原 MODEL_PRICING 可验证条目）。qwen 等**分档计价**模型不臆测收录（写单档即错价）。
3. **补价通道 = models.yaml** `custom_providers.*.models[].cost`：pricing 模块懒加载为 overlay，优先于内置表（可对 Claude 改价）；schema 字段 `cacheWrite` 映射到 `cacheCreation`。改价 = 改配置，不改代码；进程重启生效。
4. **匹配 = 两阶段，无 alias/前缀猜测**：trim+lowercase 精确 → 剥尾部 `[...]` 变体段再精确 → `null`。代理上报的 `qwen3.8-flash[1m]` 接住用户配置的 `qwen3.8-flash` 价；要给变体单定价就配精确键（阶段 1 自动优先）。
5. **`costUsd` 类型语义 = 价表估算（非账单）**；**NULL/undefined = 未定价**。不落库区分来源（不加 `cost_source` 列、无迁移）——measured|estimated 是假二分，`sdk|local` 血统差异只存在于边缘路径。UI 金额永远是估算口径。
6. **0 → undefined seam 归一**：SDK 的 0（未知模型假实测）在三个入口一律归一为未定价——claude `result.modelUsage.costUSD`、`result.total_cost_usd`、pi `token-aggregator` 的 ModelUsage 条目；tracker `LLMCallRecord.costUsd` 初始值从 0 改为未知。0 = 未定价，不 = 免费。
7. **收敛调用点 2 处**：`calibrateFromModelUsage` 兜底改 `estimateCost(priceFor())`（null 时**跳过 cost 分配**，token 的 `Σ===authTotal` 不变式不受影响）；`observability.persistLLMCalls` 落库兜底（`?? 'default'` 字符串补丁随之死）。pi 注册时 0 价模型尝试 `priceFor()` 补（`resolvePiCost`）。

## Consequences

- **正向**：locality——补价/改价只动 models.yaml 或一个 const；leverage——`priceFor/estimateCost` 一个 interface 覆盖全部估算点；假 sonnet 计费绝迹（qwen 回归钉 `priceFor('qwen3.7-max') === null` 防复活）；「未定价」经既有 `costComplete` 语义在 UI 诚实呈现。
- **代价**：qwen 系新行 `cost_usd` 从假数变 NULL——费用列对用户暂时为空，直到 models.yaml 贴价。**存量假数不回填不清洗**（解释权归 C3 ledger，与 C1 D4 同策略）。
- **移交 C3**：`analytics.ts` 的 `costEfficiency = 1 − avgCost/10` 魔数与「NULL `?? 0` 求和」——qwen 变 NULL 后该分数会系统性偏乐观，属跨执行聚合语义，归 UsageLedger 定夺。
- **验证**：单刀提交；shared pricing 10 例 + tracker 28 例（含未定价跳过分配新例）+ aggregator 0→undefined 例 + wire-contract C2 4 例 + **observability 真落库三态 4 例**（qwen→NULL / 变体匹配 / 内置兜底 / 实测优先）；全仓 tsc 无新增、各包 vitest 失败集 = HEAD 基线。

## Amendment 2026-08-30: model_presets 预设层（跨厂商价隔离 + 字段继承）

上线后发现 Decision #3/#4 的两处缺陷：**overlay 无 provider 维度**（多商 `custom_providers` 配同名 model id 异价时后写静默覆盖先写）；**pi 上报带前缀名**（`dashscope/qwen3.7-plus`）与 overlay 裸键永错位，兜底估算恒 NULL。

新增 models.yaml 顶层 `model_presets` 层（条目同 `models[]` 形，`id` 允许裸名或 `provider/model`）：

1. **继承在 raw 层做**（`applyModelPresets`，zod parse 前）：custom 条目缺失字段 ← 前缀预设 > 裸名预设。schema 字段全带 `.default()` 使 parse 后「没配」与「配 0」不可分，raw 的 `hasOwnProperty` 才是"没配"的精确语义；cost 块**逐字段**合并（条目已写字段优先）。
2. **overlay 双键装配**：custom 生效价同时写前缀键 `provider/id`（唯一不撞）与裸键 `id`（claude 代理报裸名的命面）；预设条目按 id 形态写对应键。
3. **裸键裁决**：裸名预设 = 终审直写；无预设时 custom 各商同价 → 保留、异价 → **裸键丢弃 + warn**（宁可未定价不静默选边——#1 无 default 精神的延伸）。跨商异价的正当逃逸口就是往预设层写一行裸名。
4. 预设 cost 块不完整（<4 字段）→ 该价不生效 + warn（防半块 0 伪装成价）。

验证：shared `model-presets.test.ts` 14 例（继承矩阵/裁决矩阵/双键命中）；四包 tsc/vitest 例级 = HEAD 基线零新增。
