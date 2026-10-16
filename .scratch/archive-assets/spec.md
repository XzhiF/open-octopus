# Spec: 归档资产化（P3）— 素材包 · 判例自动提取 · skill 草案管线 · 清理账

Status: ready-for-agent
Date: 2026-10-14
Scope: P3 全量（P4 残余见 Out of Scope）
Primary sources: `.scratch/knowledge-center/`（P2' spec + prototype + e2e-report 四缺陷单）· KC 分支现实（archiveIngestHook / CompileQueue 七类 opKind / 卡片注册表一行注册 / findings 通道 / 策展人对话，全部为本 phase 的插座）· 原蓝图 Tab⑥ 归档深化（四路分流思想，经 Karpathy 转向重写）

## Problem Statement

P2' 把归档变成了"一份 LLM 总结 → raw → 编译"，但归档时真正值钱的原始素材（验收台账、phase 打回记录、执行 JSONL 里的报错→修复序列、PR diff、matt 产物）只是总结 prompt 的输入，**用完即蒸发**——编译无法对质重跑，违反 raw 层"不可变源"哲学。踩过的坑不会自动变成判例（cases/ 供给靠人投喂，"卡壳按症状查判例"的消费侧建好了、供给侧是空的）。可复用的操作流程（同类修复跨 task 重复出现）没有沉淀通道——最初需求"给 Workflow Engine 的分身增加技能"至今没有自动化路径。同时 P2' 留下一串清理账：默认库索引与真盘偏差（轻核实证：12 行 vs 34 页）、pending_review 空表、死码三件、四条 DEFER 缺陷、E2E 沉淀页去留。

## Solution

把归档升级为**资产化流水线**：素材包整体持久化进 raw（目录 + manifest，总结降级为其中一件）；执行 JSONL 与打回记录自动提取判例草案、自动入档（宽松准入 + 归档卡通知，事后可纠）；检测可复用操作流程产出 **skill 草案**，在知识中心对话里预览/修改/一键授予分身（落分身技能目录 + 官方 resource upgrade 原语同步运行时预置源 + agent_versions 即时发版，版本可回退）；语义摘要落 task metadata 使任务板可搜。P2' 的清理账在本 phase 一次清完（含默认库对账、pending_review 物理 drop、两条 DEFER 缺陷修复）。全程不新建基建：写操作进既有全局串行队列（新 opKind），新卡片走注册表一行注册，判例积压检查并入既有巡检，skill 生效只靠 ADR-0006 原生发现（零 prompt 注入）。

## User Stories

**素材包（知识流加深）**

1. 作为 owner，我想任务归档时素材包整体落 raw（`raw/archives/task-{id}/` 目录 + manifest：验收台账、phase 打回记录、执行 JSONL 关键事件摘录、PR diff 摘要、matt 产物指针、ADR/context-notes），以便编译有源可对质、可重跑。
2. 作为 owner，我想素材包每件带来源与 hash（不可变冻结契约与单文件 raw 一致），以便溯源链完整。
3. 作为 owner，我想归档卡列出素材清单（哪几件入了包、各自大小），以便事后可见全自动过程。
4. 作为 owner，我想在对话里说"重新编译 task-XXX，重点看 phase-2 打回那段"，策展人真能从素材包取到那段原始记录再编译，以便一份素材多次提炼。
5. 作为 owner，我想对话剔除某件素材（"别用 JSONL 摘录，重编"）后触发重编译，以便人对源有 curation 权（Karpathy：human curates sources）。
6. 作为策展人，我想编译素材包时 manifest 先行、按需下钻单件（token 预算纪律），以便大包不爆上下文。
7. 作为维护者，我想 JSONL 摘录是"关键事件提取"（报错/工具失败/重试/修复 commit 关联）而非全量拷贝、PR diff 是 stat 级+关键 hunk（全量指回 git），以便素材包不失控膨胀。

**判例自动提取（案例流供给侧）**

8. 作为系统，我想归档时从执行 JSONL 识别 报错→诊断→修复 序列生成判例草案（五段骨架：现场/诊断/根因/修复/教训，source 指回 exec/task），以便踩坑自动留档。
9. 作为系统，我想 phase 打回记录（验收台账的 rejected 轮次+理由）同样产出判例草案，以便流程性教训不丢。
10. 作为 owner，我想判例自动入档 cases/（宽松准入：真实+可定位，豁免半衰期）且归档卡通知——**不先问再存**（审批不复活），以便供给侧零人工。
11. 作为 owner，我想判例卡可点开五段预览、可对话退役（superseded）或让策展人改写，以便事后纠偏通道完整。
12. 作为 agent 执行者，我想卡壳按症状检索 cases/ 时命中率随每次归档自然增长，以便"判例比法条更贴现场"真的成立。
13. 作为策展人，我想同症状判例 occurrences≥2 时巡检产出"判例积压"finding（提议蒸馏为 topics 硬约束规则、互指），以便判例是规则的原料这条设计闭合。
14. 作为维护者，我想判例入档经全局串行队列（新写操作类型），以便写串行纪律无旁路。

**skill 草案管线（核心——"怎么干"的资产化）**

15. 作为系统，我想检测可复用操作流程——三路来源：跨 task 重复的同类操作序列（JSONL 工具序列相似）、判例蒸馏中标记"流程型"的知识、策展人编译素材包时的主动提议——产出 skill 草案，以便重复劳动变成可授予的资产。
16. 作为 owner，我想 skill 草案卡里预览完整 SKILL.md 渲染（name/description/触发条件/步骤/纪律），以便判断值不值得授予。
17. 作为 owner，我想对话修改草案（"加上 exponential backoff 的说明"）由策展人改写后再预览，以便草案定稿是对话的事。
18. 作为 owner，我想一键授予到指定分身（workflow-operator / task-doer / 其他），授予即发布 agent_versions 现行版（可回退到上一版），以便治理走既有版本机制、不造新审批。
19. 作为维护者，我想授予的机械链 = 草案落分身技能目录 + **官方 resource upgrade 原语**同步运行时预置源 + agent_versions 发布（P0/P1 血泪教训：直接改文件服务重启不生效），以便授予真的在运行时生效。
20. 作为 owner，我想"授给所有分身"= 落共享技能层（ADR-0005 两层模型），默认窄口授单分身（分身层），以便写权治理有层次。
21. 作为 workflow agent，我想下次执行时被授予的 skill 经 SDK 原生发现可加载可调用（ADR-0006，零 prompt 注入），以便技能生效不靠塞文本。
22. 作为 owner，我想撤销授予（版本回退 + 技能目录移除 + 预置源同步），以便授予是可逆操作。
23. 作为 owner，我想授予/撤销都有卡片回执（目标分身、版本号、预置源同步结果），以便审计链完整。
24. 作为维护者，我想 skill 草案存放于知识根 drafts 区（非 wiki git 仓、非知识页——它是待授予的过程资产），草案 front-matter 记录素材包来源指针，以便草案可溯源但不污染 wiki。

**语义摘要（任务板可搜）**

25. 作为任务板用户，我想归档后的 task metadata 带语义摘要（干了什么/关键决策/产出指针），以便板上可搜"上次做 actuator 那个任务"。
26. 作为 owner，我想任务板搜索命中语义摘要字段，以便历史任务不再靠记忆定位。

**清理账（P2' 遗留一次清完）**

27. 作为维护者，我想默认库索引对账脚本（扫盘重建 wiki_articles+FTS）作为本 phase 第一个 ops 动作，以便生产 /knowledge 与真盘一致（轻核 gap 修复）。
28. 作为维护者，我想 pending_review 表物理 drop（蓝绿：数据导出归档 → drop；skill 草案走卡片通道后表已无消费者），以便死重清零。
29. 作为维护者，我想死码三件（unmarkRuleRetired/findRuleById/listKnowledgeFiles 及同类零 importer 残留）删除、wiki 根空 v2 目录清理，以便仓库无僵尸。
30. 作为维护者，我想 D-kc15-1 修复：L5 日期类 lint 失败触发服务层一轮自纠（日期表述改写/移 sources 页后重编译），自纠仍败才终态 failed + 抓取卡带「重试编译」入口，以便含日期的一手源（最常见的真实素材！）不再恒失败。
31. 作为维护者，我想 D-kc15-2 修复：INDEX 必读节标注 user_preference 的知识根相对路径 + octo-wiki skill 必读指引同步，以便 agent 真能读到偏好文件（P2' 只兑现了一半的语义）。
32. 作为 owner，我想 E2E 沉淀处置：kc15-* 前缀 fixture 页经策展对话退役入 _retired/（用产品自己的机制 = dogfood），真源编译产物（真实文章的页）保留，以便生产库干净但不毁真知识。
33. 作为维护者，我想 shadow-compare 端点保持冻结只读（过闸文书证据链审计面），删除与否留给 P4 后议，以便审计链不断。

**端到端**

34. 作为 owner，我想看到全链演示：归档一个真 task → 素材包+总结+判例+skill 草案全部出现在知识中心对话流 → 授予 operator → 下一次真实执行 JSONL 里看到该 skill 的加载/调用，以便"归档太 Low"这个最初痛点被完整治好。
35. 作为维护者，我想 E2E 复跑脚本化（kc15-rerun 先例模式）+ 反假跑 R1-R8 + 43+故事证据映射表，以便验收可重证。

## Implementation Decisions

**前置（ops，本 phase 第一动作）**

- KC 分支（feat-knowledge-center-20261013）合入 main：轻核已 GO（九项绿 + fast-forward 零冲突），PR 附 e2e-report + 四缺陷单；合入后立即跑默认库对账（故事 27）。

**素材包**

- 契约：`raw/archives/task-{id}/`（目录形态源）+ manifest（每件：kind/origin/path/bytes/sha256）；总结从"唯一产物"降级为包内一件；既有单文件总结通道兼容读（历史归档不迁移）。
- 摘录纪律：JSONL=关键事件提取（error/tool_error/retry/fix-commit 关联行，带 exec 指针可回源全量）；PR diff=`--stat` + 关键 hunk（全量指回 git）；matt 产物=仓库内路径指针（已随 phase PR 持久）。
- archiveIngestHook 链升级：素材包落盘（先）→ 总结生成（读包）→ 入队编译（读包 manifest 先行按需下钻）→ 判例提取（同 hook 链，见下）→ 归档卡（素材清单+编译结果+判例数）。失败语义不变：任何一步失败不阻塞 done，K11 零触碰。

**判例自动提取**

- 提取源：本次归档任务的执行 JSONL（报错→修复序列）+ 验收台账 rejected 轮次；LLM seam 产五段草案（mock 先例：ArchiveIngestService summarize seam 同款）。
- 入档：全局串行队列新 opKind（第八类写操作，单源枚举扩）→ 经唯一写闸编译进 cases/（准入宽松、append-only、front-matter 判例 schema 沿用 P0）→ 判例卡通知。
- occurrences 合并：同症状判定复用规则近义先例（归一化+jaccard）；命中既判例则 occurrences+1（status/rule_ref 更新面，不改写正文）。
- 巡检扩查：patrol 五查 → 六查（+判例积压：open 且 occurrences≥2 未蒸馏 → finding 提议蒸馏，蒸馏产物进 topics 硬约束并互指）。

**skill 草案管线**

- 草案存放：知识根 `drafts/skills/{name}/SKILL.md`（不在 wiki git 仓、不是知识页、不进 INDEX；front-matter 记来源素材包/exec 指针 + status: draft|granted|revoked）。
- 检测三路：跨 task 工具序列相似（JSONL 面，阈值宽进严出——草案卡人裁）、判例蒸馏标记流程型、策展人编译时主动提议。检测在归档 hook 与巡检两处触发，产出草案卡不自动授予。
- 授予机械链（故事 19 逐字）：草案 → 目标分身技能目录（分身层默认；"授给所有"=共享层，ADR-0005）→ 官方 resource upgrade 原语同步运行时预置源 → agent_versions 发布现行版（授予即发版，fork ③A）→ 卡片回执（分身/版本/预置源同步结果）。撤销 = 逆链 + 版本回退。授予不经 wiki 写队列（非 wiki 写），但发布走 agent_versions 既有事务。
- 生效验证面：preflight 预置 + SDK settingSources 原生发现（ADR-0006 红线：禁止任何 prompt 文本注入方式让技能生效）。

**语义摘要**

- 归档总结的首段（或独立字段）写入 task metadata；任务板搜索消费该字段（沿用既有任务搜索通道，无新基建）。

**卡片与 UI**

- 新卡三类走注册表一行注册：素材包卡（件清单+剔除重编译钮）/ 判例卡（五段预览+source 指针+退役钮）/ skill 草案卡（SKILL.md 渲染+目标分身选择+授予/撤销钮+版本回执）。零新页面、零新路由——全部长在知识中心对话流里（对话即管理不变式）。

**清理账**

- pending_review：导出归档 → 蓝绿 drop（含索引）；代码侧 DAO/类型/边界注同步删。
- D-kc15-1：编译服务对 L5_DATES_IN_BODY 类失败做一轮自纠（LLM 改写日期表述或移 sources 页，重编译），仍败才 failed；抓取卡加重试入口。自纠不放松 lint 闸（产物仍全量过闸）。
- D-kc15-2：INDEX 重建器必读行输出知识根相对路径标注；octo-wiki skill 必读节同步措辞。
- E2E 沉淀：kc15-* 页经策展对话退役（dogfood）；真源页保留。
- 死码三件 + 空 v2 目录 + shadow-compare 处置（保留只读，故事 33）。

**治理**

- GLOSSARY 新词条：素材包 (Material Pack)、判例自动提取、skill 草案 (Skill Draft)、授予 (Grant)；修订：判例（供给侧自动化）、归档（资产化语义）。
- ADR 评估：「skill 草案管线与授予治理」若实现中出现难逆转取舍（如共享层授予的写权边界）则立 ADR，否则记入 spec 即可（避免 ADR 通胀）。

## Testing Decisions

**好测试的标准**：只断言外部行为——fs 产物（素材包结构/manifest hash/drafts/分身技能目录）、API 响应形状、DB 行（agent_versions/tasks metadata/表 drop 迁移）、provider 请求捕获（草案生成 prompt、skill 装载）、JSONL 事件；不断言内部调用序列。expected 值来自独立真相源（spec 契约/构造 fixture/原型），禁 tautological。LLM 环节一律走 seam mock（生产适配器另验离线闸），判例/草案的**内容质量不进断言**（结构与时序进）。

**五缝沿用（零新缝）**

| 故事簇 | Seam | 先例 |
|---|---|---|
| 1-7, 27-29：素材包落盘/manifest/摘录纪律/对账脚本/drop 迁移 | S1 服务层（真 fs+tmpdir，蓝绿迁移测试） | ArchiveIngestService 测试群（14 例）、wiki-migrate.test、schema-migration.test |
| 8-14, 30：判例提取/opKind 入队/occurrences 合并/巡检六查/lint 自纠 | S1（JSONL fixture→草案→入档断言；真并发不需要，串行队列已有覆盖） | patrol/findings 测试、compile 失败回滚测试 |
| 15-24 之 API 面 + 31：草案/授予/撤销/重试端点契约 | S2 路由 | wiki-routes/findings 路由契约测试 |
| 19/21：授予机械链运行时生效（预置源同步 + SDK 发现 + 版本发布） | S3 引擎/预置装配 | resource-preflight.test（票11 扩展先例）、agent-version-service 测试、workflow-operator-clone.test |
| 卡片三类/任务板摘要消费 | S4 web 组件 | KC 卡片注册表测试（38 例先例）：新卡一行注册+渲染断言 |
| 34-35：全链 E2E | 手工真跑（真 provider + 真 task 归档 + 授予后真执行见 Skill 调用）+ 复跑脚本 | kc15-rerun.mjs / e2e13-rerun.mjs 双先例、matt-e2e-test-methodology R1-R8 |

**被测模块**：归档资产化服务（素材包/判例提取）、skill 草案与授予服务、巡检扩查、编译自纠、清理迁移脚本、新卡片组件、任务板摘要消费。SKILL.md 草案文本本体不做单测（文档型产物，经 S3 装配断言间接覆盖）。

## Out of Scope

- **P4 残余**：effectiveness v2（JSONL↔blocker 关联、confidence 滚动）、doctor 数值处方全目录（膨胀榜/重复对/僵尸/低置信/域失衡）、衰减自动退役、health score、投喂入口泛化（其他会话意图路由）、深回滚程序化重建（D-kc15-3 契约窗已文档化，改进单留 P4）。
- **生产部署面**：D-kc15-4 真鉴权（属生产部署前置票，非知识域）。
- skill 市场 / 跨机分发 / 多 owner 授予权限模型（单 owner 平台）。
- shadow-compare 端点删除（保留只读审计面）。
- 素材包全量 JSONL/diff 拷贝（指针+摘录纪律，全量永远回源取）。
- 任务板 UI 改版（仅消费语义摘要字段）。

## Further Notes

- **与 P2' 的关系**：本 spec 全部长在 KC 留好的插座上（archiveIngestHook / CompileQueue opKind 单源 / 卡片注册表 / findings 通道 / 策展人对话）——实现时先读 KC 分支这五处的现状代码再动手，不重建平行机制。
- **红线继承**（KC 实现会话同款，对本 phase 继续生效）：归档先于删除（pending_review drop 前导出）；wiki 写入全局串行无旁路（判例入档走队列）；审批不复活（判例先存后知、草案人裁是"授予治理"不是"入库审批"——skill 授予改变的是分身能力面不是知识面，人裁正当）；agent 记忆域零触碰；K11 语义零触碰；唯一写闸 + 人工文件写保护。
- **判例质量风险预案**：自动提取的判例可能低质（噪声入档）。缓解 = 宽松准入的本意（cases 域隔离于默认导航，只被症状检索命中）+ 判例卡事后纠 + 巡检积压蒸馏时人裁。若实测噪声高，收紧提取阈值是运营参数不是架构改动。
- **E2E 沉淀处置（故事 32）同时是 dogfood 验收**：用策展对话退役 kc15-* 页这一步本身就是对"对话即管理"的真跑验证，一石二鸟。
- 原型：本 phase 不产新原型（UI 增量 = 三张卡片，长在已验收的知识中心形态里）；卡片 mockup 以 KC 原型 Tab④ 卡片目录为基线扩三行，实现后回写。
