# 08: doctor 数值处方 + health score

**What to build:** 巡检从语义面扩到数值全目录：膨胀榜/重复对/僵尸/低置信/域失衡五查 + volatile 到期，全部产 findings 走既有卡裁决即编译；全库 health score 0-100 进健康条，点开出按 severity 分组的 ranked findings——零新卡类零新页面。

**Blocked by:** 06（僵尸查吃记账）, 07（低置信查吃 confidence）

**Reference:** spec §Implementation Decisions「doctor 数值处方」· 故事 8-15 · 原蓝图 Tab⑦ doctor D1-D8 目录（D6 判例积压 P3 已做、D8 孤儿 KC 已做——本票补 D1/D2/D3/D4/D5/D7）

**Status:** done (merged → integration `fe4a5a48`，ff)

- [x] patrol 单源扩展（PatrolFindingKind 枚举扩）：D1 膨胀榜（逼近 L1 容量 80% → 预拆分提案）· D2 重复对（jaccard 批量判，附策展人合并稿）· D3 僵尸（90 天零引用，吃记账）· D4 低置信（票 07 已产，本票并入分组视图）· D5 域失衡（单页占全库锚点 >30% → hub 化提案）· D7 volatile 到期（review_after 已过 → 续期/改写/退役三选）
- [x] health score 0-100：扣分公式（open findings 按 severity 加权 + 容量水位项）**写入 SCHEMA.md**（人机共演面）；健康条展示、点开出 ranked findings 按 severity 分组（复用既有 findings 列表/卡通道）
- [x] 夜巡 scheduler 既有作业扩步骤（不新建作业）；手动"体检一下"同享数值查
- [x] 处方出口一律 finding（裁决即编译经队列）——**零新 UI、零审批形态**（负断言）
- [x] embedding 不引入（重复对 jaccard 为主，Out of Scope 纪律）
- [x] S1（构造 fixture 逐查断言：膨胀/重复/僵尸/失衡/到期各出对应 kind finding；score 公式对独立手算值）+ S2（分组列表 API）+ S4（健康条 score 与分组渲染）

## Comments

- **2026-10-15 implementer（we/08-doctor-numeric @ fe4a5a48，净触 23 文件，41 新例）**：数值五查并入 patrol() 本体（collectDrafts 同族各一 Drafts 函数）——D1 bloat=L1 同闸族逐字水位（serializePageMarkdown+estimateTokens，判例豁免同律）；D2 duplicate=**case-symptom 三件套复用**（spec 虚指 normalizeRuleText 坑照 E2 §9 钉避；阈值 0.75 宁缺勿合；合并稿 LLM seam 缺席/NOT_MERGE=空稿不毁 finding；**open 行证据未变沿用旧稿零重烧**）；D3 zombie=吃票06 账页键∪锚点 rollup 零自扫 JSONL（dormant=逾90天缓引/never=无账且 last_compiled 逾90天，PatrolDeps.now 死字段本票首消费）；D5 domain-skew=>30% 且全库≥10 锚低水位门槛；D7 volatile-expired=纯新建（真库在册 0 页，fixture 断言）。**D4 零重复产零枚举改动**（severity 表归组）。
- **health score**：`health-score.ts` 单源（100−Σseverity 权重(critical8/major4/minor2)−容量水位(越 0.8 地板部分×25)；SEVERITY_BY_KIND Record 编译期穷尽=新 kind 漏配即 tsc 红；expected 全独立手算 86/81/钳0 禁 tautology）。健康条 `score` 键=「只换值不换形」第四例（空库 null 诚实不伪造满分，S2 键集恒等钉）；ranked findings 走 `GET /findings` 每条派生 severity 键**零新端点零新页**（S4 负断言）。夜巡=builtin-knowledge-patrol 一行作业零改动自动覆盖（diff 零命中 builtin-jobs.ts 负断言级）；手动体检同享实证 findings-routes 6/6。
- **adopt 出口三类分配（红线2 面）**：duplicate⇒确定性合并执行体（两锚点原地保留=锚点丢失守门；无稿保守取主条零 LLM）；bloat/volatile-expired⇒semanticRevision 第四/五证据形态；zombie/domain-skew⇒**响亮 UNSUPPORTED**（退役归票09 窄口/对话，hub 化=对话策展）。patrol() 因 seam 改 Promise（生产 3 点接线+53 测试面 await 机械迁移）。
- **测试**：S1×37（逐查 kind+detail 手算值+幂等+ignored 不扰+时钟前移不 sleep）/S2 29+severity 面/S4 32（健康分双态+组序+零新页负断言）；全量 server 3439/35 红=档内（page-retire 日历一枚已由票09 修复）、web 3=档内 harness-floating-panel（单跑 64/64=并行 flaky 已甄别）、shared 1=档内；build/lint 绿。**阈值常量清单+SCHEMA 措辞两节建议**（健康分公式+裁决枚举十二 kind）齐备入主控治理账——模板 schema-doc.ts 已落同款文字可直接搬运。容量双轨为特性（水位=fs 事实，回落自愈）。
- **ff 入集成**：7328fbb6→fe4a5a48，票09 类目边界双向钉合（volatile 三选归人裁）经 merge 复核在场。
