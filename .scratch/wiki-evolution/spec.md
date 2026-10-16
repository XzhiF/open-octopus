# Spec: wiki 进化闭环（P4）— effectiveness v2 · doctor 数值处方 · 衰减退役 · 投喂泛化 · 缺陷清偿

Status: ready-for-agent
Date: 2026-10-15
Scope: P4 全量（两波可拆：缺陷波 ⑤⑥⑦⑧ 无数据依赖可先行；进化波 ①②③ 验收按"机制正确 + 烟测数据"口径）
Primary sources: `.scratch/knowledge-center/`（P2' spec/prototype/e2e-report 缺陷单 D-kc15-3）· `.scratch/archive-assets/`（P3 spec + 票 09 E2E 留账 D-aa16-2/3）· 原蓝图 Tab⑦ P4 节 · `knowledge_effectiveness` 表边界注（schema 内，P4 预留面宣示）

## Problem Statement

知识库现在能进（P2' raw→compile）、能产资产（P3 判例/skill 草案），但**不会自我净化**：confidence 还是编译期静态初值——一条规则到底帮没帮到执行，没人记账；僵尸规则、膨胀页、重复对没有数值化出口，库只进不出必膨胀；INDEX 800 token 硬顶会把新知识三连拒（P3 E2E 实证）；退役页不清活页入链，死链潜伏殃及 L5 闸与矛盾裁决（P3 E2E 实证）；深回滚卡在 REVERT_CONTRACT 窗（KC E2E 实证）；投喂入口只有知识中心一处，其他会话里说"编进 wiki"没人接；shadow-compare 是无消费者的死账。

## Solution

给 wiki 装上**新陈代谢**：effectiveness v2 解析执行 JSONL（wiki_refs × 后续 blocker 关联）为每条锚点记账，confidence 从静态初值变为滚动实测值；doctor 巡检从语义六查扩到数值全目录（膨胀榜/重复对/僵尸/低置信/域失衡/volatile 到期），产出 **health score 0-100** 进健康条，处方全部走既有 finding 卡裁决即编译；僵尸规则窄口**自动退役**（通知卡+可恢复），其余人裁；投喂入口泛化——任何 agent 会话说"编进 wiki"经意图路由到策展流程；三条实证缺陷清偿（深回滚改状态重建、INDEX 预算两级化、退役清入链）；shadow-compare 物理删除。全程长在既有插座上（patrol/findings/队列/卡片注册表/health 条），零新基建、零新页面。

## User Stories

**effectiveness v2（记账与置信度）**

1. 作为维护者，我想服务端增量解析执行 JSONL：wiki_refs 引用（页#锚点）与 wiki 页 Read 序列落进 knowledge_effectiveness 记账（引用计数/最近引用时间），以便每条规则的被消费量有实测数据。
2. 作为维护者，我想引用↔结果关联：同执行（及后续同 task 执行）的 review 节点 blocker 与被引锚点做语义关联（LLM seam）——同类 blocker 未再现 = helpful+1，再现 = not_helpful+1，以便"这条规则挡没挡住坑"变成账目。
3. 作为 owner，我想 confidence = helpful/(helpful+not_helpful) 滚动更新（DB 为真源，夜巡批量同步页 front-matter 快照），以便置信度反映实战而非编译期猜测。
4. 作为 owner，我想页元数据与健康条可见引用数/helpful 率/confidence 走势，以便一眼分辨"扛过事的规则"和"没人用的规则"。
5. 作为策展人，我想低置信（confidence≤0.2 且引用≥3）自动产出 finding 提议修订或退役，以便差规则不赖账。
6. 作为维护者，我想记账幂等且增量（解析游标记到 execution，重跑不重复记账），以便夜巡可反复跑。
7. 作为 agent 执行者，我想记账全程服务端零感知（不注入、不改 prompt、不加运行时开销），以便执行体验不变。

**doctor 数值处方 + health score**

8. 作为 owner，我想夜巡产出 health score 0-100 进健康条（算法与扣分权重写进 SCHEMA.md），以便库的健康一屏可见。
9. 作为 owner，我想膨胀榜检查：逼近 L1 容量闸 80% 的页 → 预拆分 finding（不等触顶硬拒），以便增长有提前量。
10. 作为 owner，我想重复对检查：跨页近义规则（jaccard 批量判）→ 合并稿 finding（附策展人生成的合并文本），以便碎片不堆积。
11. 作为 owner，我想僵尸检查：90 天零引用（JSONL 无 Read 命中 + wiki_refs 无提及，吃故事 1 的账）→ 退役 finding。
12. 作为 owner，我想域失衡检查：单页占全库锚点 >30% → hub 化/拆分 finding。
13. 作为 owner，我想 volatile 到期检查：review_after 已过 → 复审 finding（续期/改写/退役三选一裁决）。
14. 作为 owner，我想 health score 点开出 ranked findings（按 severity 分组，复用现有 finding 卡与列表），以便裁决动线零新 UI。
15. 作为维护者，我想数值检查全部并入既有 patrol 服务（语义六查 → 全目录），处方出口一律 finding（裁决即编译经队列），以便巡检单源、不复活审批。

**衰减自动退役**

16. 作为 owner，我想僵尸规则窄口自动退役：90 天零引用**且**零活页入链 → 自动迁 _retired/（replaced_by 指针 + LOG retire 行）+ 通知卡，以便"只进不出"有自动出口且不惊动人。
17. 作为 owner，我想自动退役可恢复（对话说"恢复 oct-XXX"→ 从 _retired 迁回 + 入链回补），以便窄口误伤有后悔药。
18. 作为维护者，我想自动退役经全局串行队列（新 opKind）且退役时执行入链清理（故事 26 同一路机械），以便写串行与断链纪律无旁路。

**投喂入口泛化**

19. 作为 owner，我想在任何 agent 对话里说"把这篇编进 wiki"+ URL/文本，意图路由识别后转策展流程（抓取→raw→编译），以便投喂不必先进知识中心。
20. 作为 owner，我想被路由的会话里收到同款卡片（抓取卡/diff 卡，Lane A 消息块跨会话形态），以便体验与知识中心一致。
21. 作为维护者，我想意图分类进既有 orchestrator 意图面（新类别：知识策展），路由后复用既有 ingest API 与队列，以便零平行机制。

**缺陷清偿（三条实证 + 一条死账）**

22. 作为 owner，我想深回滚任意历史编译：revert 改为**状态重建**（读目标 commit 树 → 程序化重建页/INDEX/LOG/FTS/DB 至目标态 → 单 commit），REVERT_CONFLICT 成为历史，以便回滚不受"后续 commit  touched 共行"限制。
23. 作为维护者，我想深回滚审计面完整：LOG 记 deep-revert 行（目标 commit + 重建页数），git 史线性保持。
24. 作为 owner，我想 INDEX 预算两级化：>80% 出预警 finding（提议移 Optional/拆分/hub 化），>100% 才 error 且附压缩建议——新知识不再被预算硬拒三连（P3 复现靶验证），以便增长与预算共存。
25. 作为维护者，我想 INDEX 分层渲染生效：必读+高频节恒可见、Optional 节压缩在尾（llms.txt 惯例），预算约束的是"第一跳恒见部分"。
26. 作为维护者，我想页退役时摘除活页入链（[[链接]] 改 _retired 指针或摘除，L5 断链零潜伏），且矛盾 finding 的对手页已退役时裁决降级为单侧处理（不再恒 failed），以便退役不殃及。
27. 作为维护者，我想 shadow-compare 端点+服务+测试物理删除（过闸文书证据已归档于 p2-gate-pass.md 与 KC e2e-report，删除不毁审计链），以便死账清零。

**端到端**

28. 作为 owner，我想看到记账链真跑：一条真实执行（引用锚点+review blocker）→ 夜巡记账 → confidence 变化可见 → （构造低置信）finding 产出。
29. 作为 owner，我想看到夜巡真跑：health score 落健康条 + 数值 findings（至少膨胀/僵尸/重复各构造一例）→ 裁决即编译。
30. 作为 owner，我想看到泛化投喂真跑：非知识中心会话说"编进 wiki"→ 意图路由 → 卡片回流。
31. 作为 owner，我想看到深回滚真跑：回滚一个非 HEAD-adjacent 的历史编译 → 状态重建成功、INDEX/LOG/FTS/DB 四路一致。
32. 作为维护者，我想 E2E 复跑脚本化 + 反假跑 R1-R8 + 故事证据映射表，以便验收可重证。

## Implementation Decisions

**前置（ops，本 phase 第一动作）**

- P3 分支（feat-archive-assets-20261014）合入 main：PR 附 P3 e2e-report + DEFER 单（D-aa16-2/3 由本 spec 故事 24-26 承接）；合入后跑既有对账脚本确认索引与真盘一致。

**effectiveness v2**

- 数据面：沿用 knowledge_effectiveness 预留表（rule_id/injected_count→语义改为 cited_count 或加列，蓝绿迁移；helpful/not_helpful/last_injected/confidence 列义不变）；**表边界注的告诫生效：不得复活旧关键词匹配近似**——blocker 关联走 LLM seam（语义判"同类 blocker"，mock 先例：ArchiveIngestService summarize seam / finding 修订 LLM seam 同款）。
- 解析器：服务端增量任务（夜巡触发 + 手动触发端点），输入 = executions JSONL（wiki_refs、Read 工具调用序列、review 节点产出）；游标持久（记至 execution id/时间戳），幂等（重解析零重复记账）。
- confidence 真源 = DB；页 front-matter confidence 是快照，夜巡批量刷新（经全局串行队列新 opKind：effectiveness-sync，单 commit 收口一批）。
- 记账不改任何运行时执行面（纯服务端离线解析，agent 零感知）。

**doctor 数值处方**

- patrol 服务单源扩展：语义六查（KC 五查 + P3 判例积压）+ 数值五查（膨胀/重复/僵尸/低置信/域失衡）+ volatile 到期 = 全目录；PatrolFindingKind 枚举扩，finding 卡/裁决即编译通道零改动复用。
- health score：0-100，扣分权重公式（open findings 按 severity 加权 + 容量水位项）写入 SCHEMA.md（人机共演面——owner 可调权重）；健康条与 findings 列表头展示。
- 重复对判定：jaccard（既有 normalizeRuleText/ruleTokens 先例）为主，embedding 增强不做（Out of Scope 纪律延续）。
- 夜巡 scheduler 系统作业既有挂载点扩步骤，不新建作业。

**衰减自动退役（窄口）**

- 自动退役判据（AND）：锚点 90 天零引用（吃 effectiveness 账）且所在规则行零活页入链且非人工文件；命中 → 队列 opKind（auto-retire）→ _retired/<anchor>.md（replaced_by 指针）+ LOG retire 行 + 入链摘除 + 通知卡。
- 其余一切退役（低置信/域失衡/volatile 到期/矛盾裁决）仍走 finding 人裁——自动化只开这一条窄口。
- 恢复通道：对话"恢复 oct-XXX" → 策展人从 _retired 迁回（新锚点不复用旧号纪律豁免：恢复=原号原行回迁，LOG 记 restore 行）+ 入链回补。

**投喂泛化**

- orchestrator 意图面新增"知识策展"类：命中（"编进 wiki/入库/沉淀这篇"等表述 + URL/长文本伴随特征）→ 路由到策展流程（复用 ingest API + 编译队列）；卡片经 Lane A 消息块回落原会话（跨设备形态已有）。
- 非知识中心会话的卡片按钮动作（回滚/重试）走同一套 API，前端渲染器复用注册表（零新卡类，渲染上下文适配）。

**缺陷清偿**

- 深回滚：revert 服务改**状态重建**语义——读目标 commit 的树 → 与现态 diff → 程序化重建（页文件/INDEX 重建器/LOG append deep-revert 行/FTS/DB 同步）→ 单 commit；统一走此路（不再区分 HEAD-adjacent 快路径，git revert 三方合并退役）；REVERT_CONFLICT 错误码废弃（状态重建无冲突面），LOCK_HELD/WORKTREE_DIRTY 保留。
- INDEX 预算两级化：L4 闸改 >80% warn（编译放行 + 预警 finding：移 Optional/拆分/hub 化三选提案）；>100% error（拒写 + 附压缩建议，策展人自纠）；INDEX 渲染分层（必读+正文恒见 / Optional 压缩尾部），预算口径 = 恒见部分 token。
- 退役清入链：退役执行器（人裁 finding 与自动退役共用）增加"活页入链摘除"步骤（[[链接]] → _retired 指针文本或摘除，触页经同 commit）；矛盾 finding adopt 时对手页已退役 → 降级单侧裁决（本页标记清除 + LOG 注记，不 failed）。
- shadow-compare 删除：端点/服务/测试/类型全删；p2-gate-pass.md 与 KC e2e-report 中的证据引用加注"端点已于 P4 删除，数据面见归档"。

**治理**

- GLOSSARY 新词条：effectiveness（记账）、health score、深回滚（状态重建）、数值处方、自动退役（窄口）；修订：finding（目录全量化）、巡检。
- ADR 评估：「revert = 状态重建而非 git revert」若实现中确认难逆转则立 ADR（倾向立：它改变了回滚的审计语义）；其余记 spec。
- SCHEMA.md 增补：health score 公式、自动退役窄口判据、INDEX 两级预算——共演文档随机制生长。

## Testing Decisions

**好测试的标准**：只断言外部行为——DB 行（记账/confidence/游标）、fs 产物（_retired/入链摘除后的页/INDEX 分层）、API 形状（health/findings/deep-revert）、provider 捕获（blocker 关联 LLM seam 的输入输出契约）、卡片数据面；不断言内部调用序列。expected 值来自独立真相源（构造 fixture 的已知账目、蓝图公式、spec 判据），禁 tautological。**时间相关判据（90 天/到期）用可注入时钟或构造时间戳 fixture，不 sleep。**

**五缝沿用（零新缝）**

| 故事簇 | Seam | 先例 |
|---|---|---|
| 1-7, 16-18：记账解析/关联/滚动/自动退役/恢复 | S1 服务层（JSONL fixture→记账断言；LLM seam mock；时钟注入） | patrol/findings 测试群、ArchiveIngestService seam 先例、compile 失败回滚测试 |
| 8-15, 22-27：数值检查/health score/深回滚状态重建/INDEX 两级/入链清理/shadow 删除 | S1（构造膨胀·重复·僵尸·断链 fixture 断言 finding 与产物）+ S2（health/deep-revert/手动记账端点契约） | patrol fixture 先例、revert 四同步契约测试（KC 票12 S2）、schema-migration 蓝绿先例 |
| 19-21：意图路由 | S1/S2（orchestrator 意图分类 fixture + 路由后 ingest 调用面）+ 既有 orchestrator 测试群 | octo-agent-orchestrator 既有面 |
| 4, 8, 14, 20：健康条 score/findings 分组/跨会话卡片 | S4 web 组件 | KC 卡片注册表测试（38 例）、health 条口径负断言先例 |
| 28-32：全链 E2E | 手工真跑（真执行→真记账→真夜巡→真裁决；深回滚真 git；泛化投喂真会话）+ 复跑脚本 | kc15-rerun / aa E2E 双先例、matt-e2e-test-methodology R1-R8 |

**被测模块**：effectiveness 解析器与记账服务、patrol 数值检查与 health score、自动退役执行器、revert 状态重建、INDEX 预算闸与渲染分层、orchestrator 意图类、健康条/卡片组件。**不测**：LLM 判定内容质量（只测 seam 契约与结构产物）。

## Out of Scope

- embedding 混合检索 / 重复对的向量判定（jaccard 为主，纪律延续）。
- doctor 处方**全自动执行**（自动化的口子只开"僵尸窄口退役"一条；膨胀/重复/低置信/失衡/volatile 永远人裁）。
- skill 的 effectiveness（授予的 skill 好不好用——属 skill 进化域，另议）。
- 跨 org / 多 owner 治理。
- agent 记忆系统的进化（daily/long-term 摘要质量追踪——不同域，零触碰纪律延续）。
- INDEX 预算的动态个性化（按消费模式调预算——先两级化跑起来再说）。
- 生产部署鉴权（D-kc15-4，生产部署前置票，非知识域）。

## Further Notes

- **两波节奏**：缺陷波（故事 22-27：深回滚/INDEX 两级/入链清理/shadow 删除）无数据依赖、复现靶在手（P3 E2E 留的三连拒现场、KC 留的 REVERT_CONTRACT 现场），可先行开工；进化波（故事 1-18）机制可立即建，但**验收按"机制正确 + 构造/烟测数据"口径**——有机跑量数据随日常使用自然积累，confidence 的真实收敛是运营结果不是验收门槛。
- **数据依赖的诚实注记**：effectiveness 记账需要执行史里有 wiki_refs × review blocker 的样本；当前存量执行（KC/P3 E2E 产物）可作首批解析对象（烟测），夜巡上线后随使用增厚。
- **红线继承**（KC/P3 同款）：wiki 写入全局串行（effectiveness-sync/auto-retire/deep-revert 全是新 opKind 入队）；审批不复活（数值处方=finding 事后裁决）；归档先于删除（shadow-compare 删除前证据引用加注归档位置）；agent 记忆域与 K11 零触碰；唯一写闸 + 人工文件写保护；skill 生效面零触碰（ADR-0006）。
- **knowledge_effectiveness 表边界注兑现**：本 spec 即注记要求的"连同滚动更新语义整体设计"——实现时先读该注与旧 effectiveness.ts 的 git 史（已删，教训在史里），勿复活关键词匹配近似。
- 原型：无新原型（零新页面——health score 进既有健康条、findings 走既有卡）；SCHEMA.md 增补段落落盘后即为"活文档"面。
