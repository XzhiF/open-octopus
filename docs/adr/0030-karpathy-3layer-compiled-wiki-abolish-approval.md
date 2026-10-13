# ADR-0030: Karpathy 三层编译型知识库 + 审批废除 — 输入即审批，质控六道事后化

Date: 2026-10-13
Status: Accepted
Related: **amends ADR-0029**（三分离段的 wiki 定位：「org 词条」→ 全局唯一三层库；指针行语义不变、路径换全局根）；**收编「写入单一闸门」前案**（`.scratch/llm-wiki-loop/spec.md` 架构决策 D4「审核队列 → 策展人编译 → git commit」——该前案当年未落 docs/adr，属治理欠账，本篇点名修正：其「审核」环节废除、「唯一写闸」环节保留并强化）；承 P2 过闸文书 `.scratch/llm-wiki-loop/p2-gate-pass.md`（删除注入链单向门）；数据 D6 五项裁决（spec §Implementation Decisions）

## Context

LLM-WIKI P0/P1 把知识库建成了「规则数据库 + 事前审批闸」：没有 raw 层（输入被预嚼成规则候选文本，源文档本体留在体系外，编译无法重跑、矛盾无法对质）；编译单元是规则行而非页（一次审批只触一个目标文件，知识没有跨页合成）；写入要逐条人批——但输入本就是 owner 亲自投喂或自己任务的归档总结，**输入即审批**，输出再批是双重收费。同时 wiki 挂在 org 下、与被替代的 org knowledge 旧库双轨并存（影子期），注入链与查阅链两个世界并行。/wiki 与 /experience 两个已实现 UI 被 owner 全盘否定：从最初需求起，要的就是「内置分身通过对话来管理维护」。

## Decision

按 Karpathy llm-wiki 三层架构重建（一手来源：Karpathy llm-wiki gist + `.scratch/knowledge-center/prototype.html` 唯一权威）：

1. **三层目录契约**（全局唯一，与 org 无关，D6①）：`~/.octopus/knowledge/` = `raw/{inbox,archives,research}`（层1 不可变源：投喂文章/任务归档完整总结/调研原文/对话回填摘录，落盘即 hash 冻结，策展人与一切自动流程只读）+ `wiki/`（层2 五类页网络 + INDEX.md/LOG.md 导航层 + 独立 .git）+ `SCHEMA.md`（层3 人机共演约定，首版吸收 octo-wiki-curate 编译纪律）+ `user_preference.md`（人工文件）+ `_archive/`（退役归档区）。
2. **编译单元换页**：五类页 entities/concepts/topics/sources/cases（判例沿用），页格式 v3（`type` 替代 `domain`、links/aliases/entity_kind 新增、锚点只活在 topics 硬约束小节）；一次编译触 N 页 = 一个 git commit（INDEX/LOG/FTS 同事务）。
3. **审批整体废除**：删除审核队列的 wiki 通道（rule/wiki-edit/wiki-split 策展分发、approve→curate 链、auto_approve 概念、审核 UI）。pending_review 表本体保留（skill 草案等非 wiki 用途结案流转，物理清理属 P3——schema.sql 有边界注）。触发从「逐条人批」改为「raw 投喂即编译」。
4. **写入闸门保留并强化**（质控替代审批）：唯一写闸 = 编译服务收口全部落盘（ADR-0031 的队列+锁是其外层）+ wiki 仓 pre-commit 来源标记（curate/manual）+ 人工文件写保护——`user_preference.md`/`SCHEMA.md` 在**服务层路径级硬闸拒绝**（`MANUAL_FILE_WRITE`，主闸），pre-commit 的 grep 分支为纵深防御（人工文件在知识根、正常不入 wiki 仓）。策展人对两者只出写保护卡（建议文本 + 人工确认步骤，零自动落盘）。
5. **质控六道（全事后/机械）**：输入即审批 / sources 回指不可变 raw（路径+hash 逐字在页可机械对质）/ git 一次编译一 commit + UI 一键回滚 / 结构 lint L1-L6 编译期硬闸（拆分=对话内自纠）/ 语义巡检产 findings 报对话裁决（发现面=系统报人）/ 人工文件写保护。
6. **旧世界硬废**：注入链（PromptInjector/KnowledgeInjector/precompute/透传）物理删除，任务上下文只留一行恒定指针（全局 wiki 根 + 查阅纪律，~50 token 零知识正文）；org knowledge 旧库与 experiences 数据**先归档进 `_archive/` 再删**（归档先于删除，过闸文书 §5 纪律）；shadow-compare 端点冻结只读（P2 证据链，删表属后续清理）；/wiki 与 /experience 路由删除。

## Considered Options

- **保留审批队列、只加全局 wiki 层** — 被否（owner 裁决）：输入即审批的前提下，输出再批是双重收费；且规则行审批无法表达跨页合成，队列永不清零的运维负担已被 P1 实践证实。
- **org knowledge 软废（留运行时开关可回退）** — 被否：三态配置的知识段是引擎不纯的根源；回滚改走 git revert + `_archive/` 还原（独立 commit 单步可 revert），不留开关。
- **embedding 主检索** — 被否（Karpathy 规模判断：~100 源/数百页内 INDEX+FTS 足够）；不做，开关也不留。
- **wiki 页 Web 直接编辑** — 被否：对话驱动策展人是唯一改页路径；人工文件（SCHEMA/user_preference）的改写永远由人落笔。

## Consequences

- **server**：knowledge 服务群重建（raw 冻结/策展编译/重蒸馏/巡检 findings/回填/回滚）；`routes/knowledge.ts` 与旧注入链物理删除；`knowledge_effectiveness` 表+DAO 保留为 P4「effectiveness v2」预留面（schema.sql + dao 导出有边界注，服务层死链已按 CODING_STANDARDS #5 清）；wiki tree stats 的 `pendingReview` 字段摘除（「待审核」概念废除的故事 10 负断言）。
- **engine**：注入块与透传链删除后，引擎回归纯编排（ADR-0029 的「指针 ≠ 注入」此后是唯一形态）。
- **web-app**：/knowledge 知识中心（对话主界面+八类卡片+右栏联动+健康条+Ctrl+K）；/wiki、/experience 整页删除。
- **词表同步**：GLOSSARY-MAP 新增 raw 层/五类页/编译队列/finding/回填/知识中心/SCHEMA 词条，「词条→页」「INDEX/LOG 导航层」「策展人」「导航协议」随本口径修订，「审核队列/影子期/工作经验页」废弃标注（ADR-0029 的 wiki 定位随之 amend）。
- **风险与张力**：审批废除后质控全押在「事后六道」上——任何一道闸（尤其写保护主闸）的回归都会直接污染库；故写保护从「pre-commit 单点」升为「服务层主闸 + pre-commit 纵深 + 行为测试套件（wiki-write-gate.test.ts）」三件套钉死。
