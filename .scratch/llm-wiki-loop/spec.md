# Spec: LLM-WIKI 知识闭环 — P0 Wiki 化奠基 + P1 Query 通道（影子双轨）

Status: ready-for-agent
Date: 2026-10-12
Scope: P0 + P1（P2-P4 见 Out of Scope）
Primary sources: `.scratch/llm-wiki-loop/prototype.html`（7 Tab 方案原型，决策与 UI mockup 全量）· `docs/research/knowledge-system/`（8 篇蓝图，继承其审核队列/效果追踪/衰减设计）

## Problem Statement

Agent 每次执行都是冷启动：上次踩的坑、反复强调的约束、调研过的结论，下次执行时 Agent 一无所知。现有补救是注入式的——引擎在工作流启动时用一次 LLM 预判"相关规则"，把规则文本硬塞进每个 agent 节点的 prompt：粒度失配（全节点共享一份预判）、token 浪费、且把知识策略焊死在引擎里，引擎不纯。知识本体则是"md 文档堆积"：docs/、GLOSSARY、ADR、org knowledge/*.md 各自为政，无统一索引、无词条化、无生命周期、正文里堆满行内日期注释，无法作为稳定的 LLM-WIKI 被人和 Agent 共同消费。

## Solution

建一座**编译型 RAG 的 LLM-WIKI**（Karpathy 式：检索的重活从 query 时挪到维护编译时）：知识以词条（Entry）为编译单元，front-matter 元数据 + 常青正文（零日期）+ 稳定规则锚点，INDEX.md 作 llms.txt 式导航层，git 版本化，Web-UI `/wiki` 可预览；写入走单一闸门（审核 → 策展人编译 → commit）。消费端**剔除注入、改为 Agent 主动查阅**：引擎保持纯净，agent 节点通过 `as:` 字段获得执行身份（默认新内置分身 workflow-operator），身份自带 octo-wiki skill，Agent 按导航协议（INDEX → 词条 → 检索兜底）查阅知识并留下引用（wiki_refs）。本期止于**影子双轨**：旧注入链保持运行不动，同时记录查阅行为，为下一期（P2 删除注入，单向门）采集决策数据。

## User Stories

1. 作为平台用户，我想在 Web-UI `/wiki` 页按域树浏览全部知识词条，以便知识不再是散落黑盒。
2. 作为平台用户，我想看到词条渲染正文（markdown）与元数据 chips（域/稳定性/最近编译/置信度），以便判断知识新鲜度。
3. 作为平台用户，我想全文检索词条与规则（含规则锚点命中），以便不知道域时也能定位知识。
4. 作为平台用户，我想查看 LOG.md 策展日志（一行一编译事件），以便不翻 git 也能审计知识变更近史。
5. 作为平台用户，我想在词条元数据面板看到 sources 溯源（归档/对话/文档指针），以便核实知识出处。
6. 作为维护者，我想词条采用格式 v2（front-matter 承载全部元数据、正文零日期、规则行仅不可见 id 锚点），以便词条常青可反复修订。
7. 作为维护者，我想 wiki lint 在编译期阻塞超容量写入（词条 ≤120 行/25 规则/~2000 token）并自动生成拆分提案，以便词条在漫长迭代中不无限增长。
8. 作为维护者，我想触顶词条按"文件长大成目录"拆分（hub + 子词条，导航 ≤3 跳，规则 id 跟随规则迁移不断链），以便增长有结构化出口。
9. 作为维护者，我想 INDEX.md 由程序从词条 front-matter 重建（llms.txt 风格、含 Optional 节、总预算 ≤800 token），以便 Agent 第一跳成本恒定。
10. 作为维护者，我想 wiki 目录是独立 git 仓库、每次编译一个 commit，以便任何知识变更可 diff 可回滚。
11. 作为维护者，我想 wiki_articles + wiki_fts（FTS5）经蓝绿迁移建表并由编译流程同步，以便服务端检索/统计不扫盘。
12. 作为维护者，我想一次性初始编译把存量知识（org knowledge/{projects,workflows}/*.md、GLOSSARY-MAP 条目、docs/research 与 docs/adr 蒸馏）迁入词条，且迁移脚本幂等，以便 wiki 冷启动有资产、重跑不重复。
13. 作为维护者，我想旧知识目录路径（无 orgs/ 段的历史布局）被兼容读取一次，以便迁移不丢数据。
14. 作为策展人（archive 分身），我想有编译写路径（审核通过 → 编译合并/去重/断链校验 → INDEX/LOG 重建 → FTS 同步 → git commit），以便写入永远走单一闸门。
15. 作为维护者，我想 cases/ 判例域落地（案例 schema：symptom/tags/severity/occurrences/rule_ref/source/status + 现场/诊断/根因/修复/教训五段），以便历史问题有结构化存档。
16. 作为维护者，我想案例准入宽松（真实 + source 可定位即可，豁免半衰期）且 append-only 不改写（仅 status/rule_ref 更新），以便判例层敢收、不污染规则层稳定性。
17. 作为 agent 执行者，我想 octo-wiki skill 教会我导航协议（先读 INDEX → 整读词条 → search API 兜底、禁止全库遍历），以便动手前低成本获得相关知识。
18. 作为 agent 执行者，我想按引用纪律把查阅结果写入 wiki_refs（经 vars_update 入 VarPool）并在产出关键决策处标注 [ref: 规则id]，以便效果可追踪。
19. 作为 agent 执行者，我想发现词条与现场代码矛盾时经 wiki_refs 上报 stale（而不是沉默），以便消费侧反哺生产侧。
20. 作为 agent 执行者，我卡壳时想按症状检索 cases/ 判例（symptom/tags 命中后沿 rule_ref 顺藤读规则），以便先例帮我定位问题。
21. 作为工作流作者，我想 agent 节点支持 `as: <clone>` 指定执行身份（persona + skills 快照装配，cwd 不变），以便节点级人格与能力。
22. 作为工作流作者，我想未写 `as:` 的 agent 节点默认装配 workflow-operator，以便存量工作流零改动获得知识查阅能力。
23. 作为工作流作者，我想 `as:` 身份解析与 octopus_agent 节点共用同一 IdentityResolver（agent_versions 已发布快照优先 → built-in/clones 目录兜底），以便身份语义全站一致。
24. 作为工作流作者，我想 `as:` 目标不存在时在引擎初始化即被硬闸拒绝（类似 requires.clones 的存在性检查），以便不带病执行。
25. 作为维护者，我想 workflow-operator 成为第 8 个内置分身并走 agent_versions 版本发布，以便工作流可钉住身份版本。
26. 作为 task-author，我想在写 spec / 拆 phase 前查阅 business/ 与 projects/ 词条，以便规格有领域事实依据（并在 spec Context 段声明所引词条）。
27. 作为 task-doer，我想任务上下文含一行恒定指针（wiki 根路径 + 查阅纪律提醒，~50 token，不含知识内容），且每轮实现前可查 projects/ 与 workflows/ 词条，以便避开已知陷阱。
28. 作为 CLI 用户，我想 `as:` 身份解析在 CLI 执行入口同样生效，以便双入口（Server/CLI）行为一致。
29. 作为维护者，我想 ResourceProvisioner 预检把 octo-wiki skill 预置进执行 workspace 的 .claude/skills（plugin/SDK 原生发现，ADR-0006），以便 skill 不靠 prompt 注入也能被加载。
30. 作为维护者，我想配置项 knowledge.mode（inject | query | both）控制双轨，本期默认 both（注入链原样运行 + 查阅行为记录），以便随时回退且为 P2 采集影子对照数据。
31. 作为维护者，我想影子对比数据可导出（注入的 __relevant_rule_ids vs 实际查阅命中的 wiki_refs，按执行对照），以便 P2 删除注入链的决策有实证。
32. 作为平台用户，我想 `/wiki` 页有健康概览（词条数/规则数/案例数/最近编译/待审核数），以便一眼看到知识库状态。

## Implementation Decisions

**架构决策（已在设计对话拍板）**

- **纯引擎 + 执行身份（D1）**：cwd=工作现场 / identity=clone 快照 / wiki=org 知识，三者正交。引擎只做身份解析与装配，自身无人格；分身特性属于节点数据（`as:`），不属于引擎属性。octopus_agent 保持重量级委托语义（Task Contract + 结构化返回），普通 agent 节点获得轻量身份装配，两者共用 IdentityResolver。
- **剔除路线（D2）本期不执行**：PromptInjector / KnowledgeInjector / precompute 链保持原样运行（影子期），物理删除属 P2 单向门。本期只增不删。引擎保留的注入面（Host 安全规则、goal 模式执行上下文、Task Contract、SDK settingSources）不属于知识注入，不动。
- **写入单一闸门（D4）**：一切进 wiki 的内容经 审核队列 → 策展人编译 → git commit。策展人 = archive 分身演进（内置分身注册表内，persona 已自称知识策展人），写侧 skill（octo-wiki-curate）仅它绑定；消费侧 skill（octo-wiki，只读）入共享技能层（ADR-0005 两层技能模型的共享层），全分身可发现。
- **准入策略（D5）**：规则候选过半衰期三问（3 个月后仍成立 / 可执行 / 非显然）；cases 判例豁免（历史记录天然时间绑定，只要求真实 + source 可定位）。
- **编译型表示（D3）**：Markdown 词条 + git 为真源，SQLite（wiki_articles + wiki_fts FTS5）只是索引，蓝绿迁移沿用 experiences_fts 先例。不做运行时 embedding 主检索；FTS5 MATCH + LIKE 降级（session_memory_fts 同款）；embedding 混合检索（复用 core-pack skill_search）仅作服务端可选开关，本期不默认启用。

**知识表示（格式 v2，样例来自原型）**

- 词条 front-matter（Zod schema 校验）：

```yaml
---
id: prj-octopus            # 词条 id，全库唯一
domain: projects           # projects|workflows|business|research|cases
title: Octopus 平台工程知识
summary: monorepo 构建/测试/端口规则与已知陷阱
topics: [build, test, ports, pitfall]
stability: stable          # stable | volatile（volatile 必带 review_after 日期）
last_compiled: 2026-10-12
sources: [archive:task-207, chat:session-8f21, doc:windows-bash.md]
confidence: 0.86           # 本期为静态初值，effectiveness 滚动更新属 P4
---
```

- 正文规则行：祈使句 + 不可见锚点 `- 修改 shared/ 后必须 pnpm build -w shared 再全量构建 <!--#oct-001-->`；锚点 id 全库唯一、永不复用、拆分迁移时跟随规则；交叉引用 `[[域/词条]]`（编译期断链校验）。日期/来源/审核记录一律不进正文（三处承接：front-matter sources、LOG.md、git history）。
- LOG.md 行格式（程序化 append）：`| 日期 | 动作(compile/case+/revise/retire/split) | 词条 | 摘要 | 来源 | 审核 |`。
- 案例文件：`cases/{YYYY-MM-DD}-{slug}.md`，front-matter 含 symptom/tags/severity/occurrences/rule_ref/source/status(open|distilled|superseded)，正文五段（现场/诊断/根因/修复/教训）。

**增长约束（wiki lint，编译期同步闸，阈值来自原型）**

- L1 词条容量 ≤120 行 / 25 条规则 / ~2000 token（先到为准）→ error，拒写 + 自动生成按 H2 小节的拆分提案（进审核队列）。
- L2 拆分形态：文件长大成目录（hub README ≤40 行，只放子词条一行摘要 + 指针）；导航深度 INDEX→hub→子词条三跳封顶。
- L3 单 H2 小节 ≤10 条规则 → warn（提示应独立成子词条）。
- L4 INDEX.md ≤800 token → error（低频词条移 Optional 节或强制升 hub）。
- L5 完整性：front-matter 过 schema、锚点 id 唯一、无断链（断链可由 INDEX 程序化重建自动修复）、正文禁日期（regex 巡检）、禁 >20 行代码块（长内容指回源指针）。
- L6 规则形态：祈使句/事实陈述（编译时 LLM 判定，warn + 给改写稿）、一词条一主题。

**执行身份（P1）**

- shared 工作流 schema：NodeDef 增可选 `as` 字段（分身英文代号，`/^[a-z0-9-]+$/`）；三层验证体系（L1 结构/L2 交叉约束/L3 语义）中在 L3 加"`as:` 目标可解析"存在性检查。
- IdentityResolver：从 octopus_agent 执行器抽出的共享解析（agent_versions 已发布快照 → `~/.octopus/agent/built-in|clones/{name}/` 兜底），装配语义 = snapshot.persona → systemPrompt、snapshot.skills → Skill Filter 白名单；不改变 cwd/workspace 隔离语义。
- workflow-operator 内置分身：注册表第 8 个（词条"内置分身"随之更新）；persona 行为准则（来自原型）：动手前经 octo-wiki 查阅并写 wiki_refs；遵守 cwd 的 CLAUDE.md；安全规则 > 任务书 > 知识参考；知识与现场代码冲突时以现场为准并上报 stale。config 声明 skills: [octo-wiki]（治理语义 + preflight 依据；运行时按 ADR-0006 继承共享技能）。
- octo-wiki skill（core-pack）：何时查（动手前四域 + 卡壳查 cases）、导航协议、检索兜底（`GET /api/knowledge/wiki/search`）、引用纪律（wiki_refs / [ref:] / stale 上报）、禁止事项（禁写 wiki 目录 / 禁整篇粘贴进交付物 / 禁跳过 INDEX glob）。经 ResourceProvisioner 预置进执行 workspace `.claude/skills/`。
- 指针行（指针 ≠ 注入）：task-doer 任务上下文与引擎身份装配允许恒定一行指针（wiki 根路径 + 查阅纪律，~50 token，不含知识内容）。
- 影子双轨：agent 配置增 knowledge.mode（inject|query|both），本期默认 both；query 侧记录 = wiki_refs（vars_update 入 VarPool，随执行落 JSONL/DB）；inject 侧沿用现有 VarPool 预计算键，不改动。对比导出为 P2 输入。

**服务端 API 与存储**

- `/api/knowledge/wiki/*`：tree（域树 + 统计）、article（单词条正文 + 元数据 + LOG 摘要）、search（FTS5，参数 q/org/topK/domain，domain=cases 支持 symptom/tags 加权）；只读；沿用 apiFetch/handleResponse 客户端模式。
- wiki 根：`~/.octopus/orgs/{org}/knowledge/wiki/`（以代码现实 orgs/ 路径为准；蓝图旧路径 `~/.octopus/{org}/knowledge/` 兼容读一次）；wiki 根 git init，编译写路径全部经策展服务收口（技术强制写权 = wiki repo pre-commit 拒绝非策展通道写入，作为故事 14 的一部分）。
- 编译服务（server knowledge 服务层扩展）：validate(lint) → compileEntry(合并/去重/断链校验) → rebuildIndex → appendLog → syncFts → gitCommit，事务性失败回滚（fs 临时目录 + 原子替换）。
- 初始编译：一次性迁移命令（幂等，可重跑），产物 = 四域词条 + INDEX + LOG 首行 + git 初始 commit；pipeline.yaml prompts 存量内容在影子期人工分流（迁词条或 operator persona），分流完成是 P2 的前置（本期只登记不强制完成）。

**Web-UI**

- 新路由 `/wiki`：三栏（域树含计数 / 词条渲染 + chips / 元数据面板：sources、git 近史、LOG 摘录）+ 顶部检索 + 健康概览条（故事 32）。复用 MarkdownPreview（react-markdown + remark-gfm + rehype-sanitize）与暗色 TUI 主题；本期只读，无编辑/审核操作入口（既有 /experience KnowledgeTab 不动、不合并）。

## Testing Decisions

**好测试的标准**：只断言外部行为——API 响应形状、文件系统产物（词条/INDEX/LOG/git log）、provider 请求捕获（systemPrompt/skills/prompt）、DB 行；不断言内部调用序列。禁止 Tautological Test：expected 值必须来自独立真相源（原型样例、词汇表定义、构造好的 fixture），不从被测实现反推。

**验证策略绑定（故事簇 → 验证方法）**

| 故事簇 | 验证方法 | Seam |
|---|---|---|
| 6-16, 32(数据面)：词条格式 / lint / INDEX / LOG / 拆分 / 初始编译 / cases / 编译写路径 | 单元 + 环级测试，真 fs + tmpdir（file-ops.test 先例）；lint 阻塞用构造超限 fixture 断言 error 与拆分提案产物；初始编译断言幂等（重跑 diff 为空）与旧路径兼容 | S1 knowledge 服务层（knowledge-loop.test.ts 环级先例） |
| 11：建表迁移 | 蓝绿迁移测试（experiences_fts 先例）：迁移前后 FTS 可查、旧库升级不丢行 | S1 + DB |
| 1-5, 32(UI)：/wiki 页 | 组件测试（billing __tests__ .test.tsx 先例）：mock API 断言域树/词条渲染/检索交互；MarkdownPreview 走 sanitize 既有保障 | web-app 组件缝 |
| 3, 17(检索兜底), 20：wiki API | 路由契约测试（archive-routes.test.ts 先例）：tree/article/search 形状、FTS 命中与 LIKE 降级、domain=cases 过滤 | S3 routes 缝 |
| 21-25, 28：as: / IdentityResolver / operator / 硬闸 / CLI 一致 | engine 测试（agent.test.ts、octopus-agent、integration.test.ts 先例）：mock provider 捕获 systemPrompt=persona、skills=快照白名单、cwd 不变；`as:` 缺失目标在 engine-init 硬闸报错；schema 校验测试（config-validation.test.ts 先例）；缺省装配断言 workflow-operator | S2 engine 装配缝 + shared schema |
| 17-19, 26-27, 29-31：skill 预置 / 指针行 / 影子记录 | preflight 既有测试扩展（octo-wiki 出现在预置产物）；task-doer 上下文断言含指针行且不含知识正文；引擎级测试断言 vars_update wiki_refs 落 VarPool 与 JSONL；影子导出按执行对照 fixture 断言 | S2 + 既有 task-doer-service 测试 |
| 端到端验收（至少 1 票，matt-verified-tickets 约定） | dev 实例跑一条含 `as:` 的真实 agent 节点工作流：JSONL 出现 INDEX→词条 Read 序列 + wiki_refs 落库；/wiki 页可见词条被引用记录（静态展示 sources 即可） | 手工 E2E（octo-debug-workflow 模式） |

**被测模块**：server knowledge 服务层（编译器/lint/索引/迁移）、server wiki 路由、engine 执行器工厂与 identity 解析、shared schema、web-app /wiki 页组件、core-pack octo-wiki 预置链路。SKILL.md 文本本体不做单测（文档型产物，行为经 S2 装配断言间接覆盖）。

## Out of Scope

- **P2 剔除注入链**（单向门，需影子数据 + 显式批准）：删除 PromptInjector / KnowledgeInjector / precompute / 透传链、pi prompt-enhancer 指针化、pipeline.yaml prompts 字段废弃、knowledge.mode 收敛到 query。
  > **2026-10-13 更新：闸门已通过**（烟测级实证 14 执行 + owner 显式批准 + 强制缓解条件），见 `p2-gate-pass.md`。P2 与「wiki 全局唯一化 + org knowledge 退役」合并为新 phase，由单独 spec 承载。
- **P3 Task 级归档深化**：extractV2 挂 task archiving 态、四路分流（知识候选/案例/skill 草案/语义摘要）、归档面板增强、skill 草案授予链路。
- **P4 进化闭环**：wiki doctor 夜检（D1-D8 + health score + 处方队列）、effectiveness v2（JSONL 解析 ↔ blocker 关联、confidence 滚动）、衰减退役自动化、策展人对话维护全量开放、审核队列 UI 强化、/experience KnowledgeTab 并入 /wiki。
- L4 embedding 混合检索默认启用（开关留、不接主链路）。
- 词条 Web 端编辑（本期只读；写入仅策展通道）。
- 跨 org 知识共享 / 全局层（~/.octopus/knowledge/）写路径。
- volatile 词条到期自动进审核队列（doctor 检查项，P4）。

## Further Notes

- **P2 是单向门**：本 spec 刻意止步影子期；删除注入链前必须 review 影子对照数据（故事 31 的导出），并单独 spec + 显式批准。回滚开关：knowledge.mode 回 inject 即恢复现状。
- **新词条待入册**（实现落地时按 domain.md 消费规则更新 GLOSSARY-MAP.md）：词条 (Entry)、策展人 (Curator)、执行身份 (Execution Identity)、判例 (Case)、影子期 (Shadow Mode)、wiki lint / wiki doctor、导航协议。"内置分身"词条 7→8（workflow-operator）。
- **建议新 ADR**：「纯引擎 + 执行身份」（D1，难逆转决策：引擎无人格、身份是节点数据）与「编译型知识库、注入式消费退役路线」（D2/D3）。放 docs/adr/ 顺延编号。
- **ADR 遵守**：0005（两层技能模型：octo-wiki 入共享层、curate 入分身层）、0006（技能经 plugin/SDK 原生发现，禁止 prompt 文本注入技能——octo-wiki 预置走 Provisioner）、0013（provision 语义与 workflow 解析集不动）、0025（task-doer 对话边界不动，只加指针行）。
- 原型 `prototype.html` 保留为 primary source，票内引用不复制；实现若与原型冲突，以本 spec 文字为准并回写原型。
- 影子期既有注入行为零改动是硬约束：P1 任何票不得触碰 PromptInjector/KnowledgeInjector/precompute 的行为（读它们的输出做对照除外）。
