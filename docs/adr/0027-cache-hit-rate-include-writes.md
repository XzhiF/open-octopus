# 命中率分母含缓存写 — cacheHitRate 口径 amend

日期:2026-10-10 · 状态:Accepted · 关联:amends ADR-0016（Decision 第 5 条的 cacheHitRate 唯一公式句，其余各条不动）；承 ADR-0014（四字段规范形状）/ ADR-0015（缓存写 1.25× 计价）

## Decision

**cacheHitRate 唯一公式改为 `cacheRead/(input+cacheRead+cacheCreation)`** ∈ 0–1，分母（新口径）为 0 → `null`——即 ADR-0016 第 5 条「唯一公式 = `cacheRead/(input+cacheRead)`」那句由本篇点名 amend。单源仍在 `shared/ledger.ts`：JS `cacheHitRateOf` 与 `LEDGER_SQL.cacheHitRate` 两处同步改，server DAO/web/CLI 全为透传消费，逐级下打无散点（全仓 grep 证实账本外零手写镜像公式，金表测试继续钉 JS≡SQL）。

为什么：旧分母把 cache_creation 同时排除在"命中"与"未命中"两侧——只要 input≈0 而 cacheRead 大，无论缓存写多少，命中率恒报 100.0%。真机（用户 2026-10-10 指正）同屏出现「缓存写 384.2K」与「命中率 100.0%」（318 in / 4.4M read / 384.2K write），语义自相矛盾：缓存写是按 1.25× 计价的真金白银（ADR-0015），是"写进去尚未被复用"的**未命中侧**流量，长会话每轮都在续写缓存，100% 命中率的读感就是假繁荣。命中率要回答"输入类 token 里多少被复用"，分母必须含写入。

## Considered Options

- **保留旧公式、把 UI 标签改成「缓存读占比」** — 被否（用户裁决）：换名只是粉饰数字，且"命中率"一词已钉死在 UI 文案、ADR-0016/0017、GLOSSARY 与 wire 字段名（`cacheHitRate`）多处；改口径一处单源下打，改名字反而处处要动。
- **分母含写、null 守卫维持 `input+cacheRead`** — 被否：守卫与分母必须同式，否则纯缓存写组（in=0、read=0、write>0）报 null，把"写了从未命中"这一真实 0% 藏成"无数据"。

## Consequences

- 数值换轨（纠错性，与 ADR-0016 换轨先例同类）：一切 cache_creation>0 的组命中率下降（真机例 100.0%→92.0%）；cache_creation=0 的组数值不变；归档冻结快照按生成时口径留存、不回填（0016「存量假数不回填」纪律照旧）。
- null 语义边界移动：三字段（input/cacheRead/cacheCreation）全 0 → null 不变；但 input=0、cacheRead=0、cacheCreation>0 的纯缓存写组从 null 翻为 **0.0**——"不造假 0%"从此只保护无任何缓存活动的组，写了缓存没命中是真 0% 不是假数（ledger-sql-mirror f4 钉值随两侧同步翻转，金表照绿）。
- 测试面：shared ledger.test.ts 公式用例重写 + 新增**真机回归用例**（318 / 4_400_000 / 384_200 → 4.4M/4.784518M ≈ 0.920，钉住本 ADR 的动因数字）；server 的 session-usage / ledger-e2e-consistency / executions-llm-calls-bynode 与 web 的 task-board / tasks-board-usage / session-cost-chip 含 cacheCreation>0 的期望逐处重算。
- 词表同步：GLOSSARY-MAP「UsageLedger」行的公式文字随改，引用记 ADR-0016 + ADR-0027。
