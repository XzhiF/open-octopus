# Spec: 知识中心 — Karpathy 三层知识库（P2'：全局化 + 旧知识硬废 + 对话即管理）

Status: ready-for-agent
Date: 2026-10-13
Scope: M1-M4（P2' phase 全量；P3/P4 残余见 Out of Scope）
Primary sources: `.scratch/knowledge-center/prototype.html`（**唯一权威**，v2 原型：三层架构/五类页/无审批/写串行/知识中心 UI/M1-M4）· `.scratch/llm-wiki-loop/`（P0/P1 as-built 历史：spec + e2e-report.md + **p2-gate-pass.md 过闸文书**）· Karpathy llm-wiki gist（外部一手：三层/三操作/index+log/无审批/规模判断）

## Problem Statement

P0/P1 把知识库建成了「规则数据库 + 事前审批闸」：没有 raw 层（输入被预嚼成规则候选文本，源文档本体留在体系外，编译无法重跑、矛盾无法对质）；编译单元是规则行而非页（一次审批只触一个目标文件，知识没有跨页合成）；写入要逐条人批（但输入本就是 owner 亲自投喂或自己任务的归档总结——输入即审批，输出再批是双重收费）。同时 wiki 挂在 org 下、与被替代的 org knowledge 旧库双轨并存（影子期），注入链与查阅链两个世界并行，维护成本高、心智负担重。两个已实现的 UI（/wiki「知识词条」三栏页、/experience「工作经验」页）被 owner 全盘否定：文件浏览器式的知识管理不是想要的形态——从最初需求起，要的就是"内置分身通过对话来管理维护"。

## Solution

按 Karpathy llm-wiki 三层架构重建：**raw/**（不可变源：对话投喂的文章、任务归档完整总结、调研原文——source of truth，策展人只读）→ **wiki/**（策展人分身全权维护的五类页网络：entities 实体 / concepts 概念 / topics 主题 / sources 来源摘要 / cases 判例，INDEX.md 导航 + LOG.md 时间线 + 独立 git 仓）→ **SCHEMA.md**（人机共演的约定文档）。**审批队列整体废除**：写入闸门保留（唯一编译服务 + git commit），但触发从"逐条人批"改为"raw 投喂即编译"，质控改为事后六道（输入即审批 / 溯源回指不可变 raw / git 可逆+一键回滚 / 结构 lint 硬闸 / 巡检 findings 报对话裁决 / 人工文件写保护）。**wiki 全局唯一**（与 org 无关），org knowledge 旧库与整条注入链**硬废**（目录与数据归档不删除）。**wiki 写入全局串行**：一切写操作经全局 FIFO 编译队列（进程内互斥）+ wiki 根锁文件（跨进程保底），一次只许一个编译，读永不锁。新建 **/knowledge 知识中心**：与策展人（archive 分身）的对话流是主界面，结构化卡片沉淀每次操作（抓取/摘要/编译 diff/归档/finding/回填/词条/写保护八类），右栏 wiki 视图实时联动（我们的 Obsidian）；/wiki 与 /experience 两个旧路由连同经验库、偏好编辑器全部删除。

## User Stories

**Owner / 平台用户（知识中心）**

1. 作为 owner，我想在知识中心对话里贴一个 URL 说"编进 wiki"，以便新知识一条指令入库，不用手工整理。
2. 作为 owner，我想直接粘贴文本或给本地文件路径投喂，以便没有 URL 的素材（会议纪要、片段笔记）也能进 raw。
3. 作为 owner，我想投喂后先看到抓取卡（raw 路径/大小/hash），以便确认源已不可变冻结、编译有据可对质。
4. 作为 owner，我想编译完成后收到 diff 卡（触及 N 页明细/冲突数/新页数/commit hash），以便一眼看清这次编译改了什么。
5. 作为 owner，我想在 diff 卡上点「回滚本次编译」，以便发现编错了能一键恢复（git revert + INDEX/LOG/FTS 重同步）。
6. 作为 owner，我想右栏 wiki 视图跟随对话自动渲染提到的页，以便边聊边看编译结果，不用切页。——**⚠️ 已废除（ADR-0033，2026-10-16 owner 真用判词「反人类」）：跟随=对阅读面的焦点劫持，替代契约=引用药丸（卡片引用页时页头亮药丸，显式点击才跳转，永不自动跳）。勿按本条修回。**
7. 作为 owner，我想把右栏钉住在某一页，以便连续追问时视图不被跳走。——**⚠️ 已废除（ADR-0033）：跟随停则钉无所指；「不跳」成为默认且唯一行为。**
8. 作为 owner，我想有浏览模式（INDEX 五类树 + 页渲染 + sources 溯源/git 近史折叠区），以便不对话时也能翻库。——**⚠️ 模式概念已废除（ADR-0033）：本条诉求升级为 wiki 主场恒定布局（左树+中正文+右栏 TOC/实效/反链），对话收纳于不重排布局的策展人抽屉；INDEX.md 从「树的隐喻」升格为上树的只读总览节点。**
9. 作为 owner，我想有 Ctrl+K 检索命令条（页名/别名/锚点/FTS5 全文），以便不知道分类时也能秒定位。
10. 作为 owner，我想健康条显示 页数按类/raw 源数/本周 ingest/开放 findings/编译队列深度/最近编译/git HEAD，以便一屏掌握库的状态——且**没有"待审核"计数**（那个概念已废除）。
11. 作为 owner，我想编译排队时卡片显示「排队中 #N → 编译中 → 已提交」，以便长编译不阻塞对话且进度可见。
12. 作为 owner，我想 finding 卡带 [采纳修订/忽略/讨论] 三钮且裁决即编译，以便矛盾/stale/孤儿页的处理是对话里一句话的事，不是去另一个页面排队。
13. 作为 owner，我想对话里说"体检一下"就触发语义巡检，以便不等夜巡也能主动查库的健康。
14. 作为 owner，我想策展人给出有价值的合成答案时出现回填卡 [编进 wiki]，以便探索成果沉淀进库（探索复利）。
15. 作为 owner，我想 task 归档后对话流里自动出现归档编译卡（总结已落 raw/archives、触及页数、commit），以便归档知识零操作入库、事后可纠。
16. 作为 owner，我想 user_preference.md 在浏览模式只读渲染并标注"人工文件，直接编辑"，以便看得到偏好但清楚 AI 不会碰它。——**⚠️ 已整体退役（ADR-0033，owner 裁决「一点用没有，彻底删除」）：UI/读端点/readUserPreference/INDEX 必读行（改指 SCHEMA.md）/persona 提及/文件本体入 `_archive/` 全清。SCHEMA.md 人工文件面不受影响。**
17. 作为 owner，我想 LOG.md 时间线视图（行格式可 grep），以便不翻 git 也能审计知识变更近史。
18. 作为 owner，我想整个知识库全局唯一、界面没有任何 org 切换，以便知识不再按组织割裂。

**策展人（archive 分身）**

19. 作为策展人，我想每次编译前必读 SCHEMA.md + INDEX.md，以便编译纪律和现库结构永远在手。
20. 作为策展人，我想全文读 raw 源、抽取实体/概念/断言、对照现 wiki 做 diff 后一次编译触 N 页（新建页+更新页+INDEX+LOG+FTS 一个 commit），以便知识是跨页合成的而不是逐条追加。
21. 作为策展人，我想发现新源与旧断言矛盾时在两页做矛盾标记并报 finding（不静默覆盖、不自行裁决），以便 owner 决定谁对。
22. 作为策展人，我想为每个 raw 源生成 sources/ 摘要页（要点 + 触及页清单 + 回指 raw 路径与 hash），以便每条编译产物都能溯源对质。
23. 作为策展人，我想结构 lint 拒绝时（超容量/断链/形态）在对话内自纠重编译（拆分/改写），以便机械质量问题不打扰 owner。
24. 作为策展人，我想对 user_preference.md 和 SCHEMA.md 只产出修改建议文本（写保护卡），以便人工文件的改写永远由人落笔。
25. 作为策展人，我想一切写操作（编译/修订/回滚/重蒸馏）都经全局 FIFO 队列与 wiki 根锁，以便永远不会和另一个编译互踩。

**工作流 Agent（workflow-operator / task-author / task-doer）**

26. 作为 agent 执行者，我想 octo-wiki skill 教我按五类页查阅（项目/服务/工具→entities，SOP/工作流→topics，术语/概念→concepts，溯源→sources，卡壳按症状→cases），以便动手前低成本拿到相关知识。
27. 作为 agent 执行者，我想导航协议保持不变（INDEX → 页整读 → search API 兜底，禁全库遍历），以便查阅成本恒定。
28. 作为 agent 执行者，我想 wiki_refs 引用格式不变（词条id#锚点，锚点现存于 topics 硬约束小节且旧锚号迁移后仍可解析），以便历史执行的引用不断链。
29. 作为 agent 执行者，我想发现页内容与现场代码矛盾时经 wiki_refs 上报 stale，且该信号最终成为知识中心的 finding，以便消费侧反哺生产侧真的闭环。
30. 作为 agent 执行者，我想任务上下文里只有一行恒定指针（全局 wiki 根 + 查阅纪律，~50 token，零知识正文），以便 prompt 干净。
31. 作为 agent 执行者，我想执行时 prompt 里再无任何注入的规则文本（注入链已物理删除），以便知识只来自我主动查阅。

**维护者 / 系统**

32. 作为维护者，我想 raw/ 落盘即冻结（hash 记录，策展人与一切自动流程只读），以便 source of truth 不可篡改、编译可重跑。
33. 作为维护者，我想 xzf-dev 的 wiki 连 .git 整体搬到全局根且 git 史连续可查，以便迁移不断代。
34. 作为维护者，我想 22 条 v2 词条重蒸馏为 v3 五类页（规则行进 topics 硬约束、锚点原号随迁、旧页迁 _retired/v2/），且脚本幂等、单 commit 可整体 revert，以便 taxonomy 换代不丢知识不断引用。
35. 作为维护者，我想 LOG.md 旧表格行机械转换为 `## [date] op | title` 行格式（原表封 git 史），以便时间线可 grep。
36. 作为维护者，我想 org knowledge 目录与 experiences 数据先归档进 _archive/ 再删表删目录，以便硬废可回滚（过闸文书 §5 纪律）。
37. 作为维护者，我想注入链物理删除后 engine/server 测试全绿、CLI 与 Server 双入口行为一致、存量工作流（无 as: 与 octopus_agent 委托）零回归，以便删得干净且不伤无辜。
38. 作为维护者，我想 /wiki 与 /experience 路由删除后旧链接得到明确处置（404 或跳转 /knowledge），以便不留半死页面。
39. 作为维护者，我想锁文件带 PID+心跳、进程崩溃后 stale 锁自动回收，以便写串行不会因一次崩溃永久卡死。
40. 作为维护者，我想并发两路投喂时编译串行落库（LOG 时间线不交错、git 线性无 merge commit），以便全局串行是可验证的硬保证。
41. 作为维护者，我想 DB 索引层平滑切换（wiki_articles org 钉 'global'、类型值切五类、FTS 重建、蓝绿迁移不丢行），以便服务端检索/统计不扫盘的纪律延续。
42. 作为维护者，我想夜巡（scheduler 系统作业）产出语义 findings（矛盾/stale/孤儿/概念缺页/缺交叉引用）报进知识中心对话，以便发现面是"系统报人"而不是"人盯队列"。
43. 作为维护者，我想任务归档在 archiving 态自动产出完整总结落 raw/archives/ 并异步触发编译（失败不阻塞 done、K11 归并语义不动），以便归档零人工沉淀知识。

## Implementation Decisions

**已拍板的前置决策（引用，不再开放）**

- D6 五项（2026-10-13）：wiki 全局唯一（DB org 列钉常量 'global'，schema 不动）· org knowledge 硬废（注入链物理删除，目录归档不删）· user_preference.md 迁知识根（写保护继承）· xzf-dev wiki 连 .git 整体搬家 + DB re-key · **P0/P1 分支先合入 main**（合前对 D2 修复 770d9fa6 跑运行时复验），本 phase 开新分支。
- P2 过闸文书（p2-gate-pass.md）：闸门以"14 条真执行烟测实证 + owner 显式批准 + 四条强制缓解"通过；缓解条件（归档不删/git 回滚/user_preference 不丢/D2 复验）对本 spec 全部生效。
- 删除边界（owner 裁决 2026-10-13）：**/experience 整页删除，含经验库**（"我要用全新的 wiki，删除干净一点"）；**偏好编辑器彻底删除**（user_preference 只留只读渲染，改文件=人工直接编辑）。**agent 记忆系统（daily/long-term/session 记忆及其 UI）是另一个域，不在删除面。**

**三层架构（Karpathy 对齐）**

- 目录契约：`~/.octopus/knowledge/` = `raw/{inbox,archives,research}`（不可变源，hash 冻结，策展人只读）+ `wiki/`（INDEX.md、LOG.md、entities/、concepts/、topics/、sources/、cases/、_retired/、独立 .git）+ `SCHEMA.md`（共演约定，首版吸收 octo-wiki-curate skill 的编译纪律；skill 本体瘦身为指针+编译 API 用法）+ `user_preference.md`（人工文件）+ `_archive/`（退役归档区）。
- 页格式 v3：front-matter 以 `type`（entity/concept/topic/source/case）替代 `domain`；新增 `links`（[[wikilink]]，编译期断链校验保留）与 entity 的 `aliases/entity_kind`；正文零日期、锚点 `<!--#oct-NNN-->` **只存在于 topics 硬约束小节**（全库唯一、永不复用、重蒸馏原号随迁）；v2 的 stability/confidence/sources/last_compiled 保留。
- INDEX.md 按 必读/Entities/Concepts/Topics/Sources/Cases/Optional 分类，程序化重建（永不经 LLM/人手写），预算 ≤800 token 纪律保留。LOG.md 行格式 `## [date] ingest|compile|query|lint|revert | title → 结果`（grep 前缀友好，Karpathy 同款）。
- SQLite 仍是索引非真源：wiki_articles（org 钉 'global'，domain 列存 v3 type 值）+ wiki_fts 重建；蓝绿迁移沿用既有先例，不丢行。
- 不做 embedding 主检索（Karpathy 规模判断：~100 源/数百页内 INDEX+FTS 足够）；search API（FTS5 MATCH + LIKE 降级）沿用。

**全局写串行（owner 裁决 2026-10-13：wiki 写入不许并发）**

- 两级机制：**进程内全局 FIFO 编译队列**（唯一写闸编译服务外包异步互斥；一切写操作——投喂编译/归档编译/对话修订/lint 自纠/finding 修复/回滚 revert/重蒸馏——统一入队）+ **wiki 根锁文件**（跨进程保底，防同机双实例双写；PID+心跳判 stale，崩溃自动回收）。
- 语义：读永不锁（浏览/检索/agent 查阅不受阻）；raw 落盘不入队（新增不可变文件无共享状态），其触发的编译才入队；单次编译失败→自身事务回滚（既有原子机制）→释放锁→队列继续，不堵死；锚点发号（全库 max+1）在串行化后天然无竞态。
- 可观测：队列深度进健康条；卡片带排队状态（排队中 #N → 编译中 → 已提交 hash）。

**审批废除与写入闸门**

- 删除：审核队列的 wiki 通道（rule/wiki-edit/wiki-split 策展分发）、approve→curate 链、拆分提案入队语义、auto_approve 概念、审核 UI 组件。pending_review 表本体保留（skill 草案等非 wiki 用途仍在用，物理清理属 P3）。
- 保留并强化：唯一写闸（编译服务收口全部落盘）+ wiki 仓 pre-commit 来源标记（curate/manual）+ user_preference/SCHEMA 写保护（策展人只出建议文本，pre-commit 对触及人工文件的自动提交拒绝）。
- 质控六道（替代事前审批）：输入即审批 / sources 回指不可变 raw / git 一次编译一 commit + UI 一键回滚 / 结构 lint L1-L6 编译期硬闸（拆分改对话内自纠）/ 语义巡检 findings 报对话 / 人工文件写保护。

**注入链与旧库硬废（P2 执行）**

- 物理删除：PromptInjector（pipeline.yaml prompts 消费）· KnowledgeInjector · precompute（__relevant_rule_ids/__user_preference_text 预计算）· 透传链 · 审核双写 append（旧知识文件追加轨道）· knowledge.mode 三态配置（收敛后删除，回滚靠 git revert + _archive 还原，不留运行时开关）。
- pi prompt-enhancer 知识段指针化（一行全局 wiki 根 + 查阅纪律）。shadow-compare 端点保留只读（过闸文书证据链引用它；注入侧字段冻结为空），删表属后续清理。
- 保留的注入面不动：Host 安全规则、goal 执行上下文、Task Contract、SDK settingSources（编排数据非知识）。
- 数据归档后删除：org knowledge 各目录（xzf-dev projects/workflows、testorg projects、各 org user_preference 原件）→ `_archive/org-knowledge-{date}/`；experiences 数据导出归档 → drop 表（含 FTS）；经验提炼/归并管线（三级提炼、experience-merger）随归档自动化替代而删除。归档动作先于删除动作，同一迁移脚本内有序执行、幂等可重跑。
- 归档自动投喂（轻量版，替代三级提炼）：task archiving 态一次 LLM 调用产出完整总结（验收台账/关键决策/踩坑/产出指针）→ `raw/archives/task-{id}-summary.md` → 异步触发编译；失败不阻塞 done，K11 归并语义（ADR 顺延/GLOSSARY 合并/git 成功才 done）零触碰。完整四路分流（skill 草案授予链等）仍属 P3。

**消费链（改动极小）**

- octo-wiki skill：导航协议/引用纪律/stale 上报/禁止事项全部保留；「何时查阅」切 v3 五类页；user_preference 必读由 INDEX 必读节承接；指针行路径改全局根。
- as:/IdentityResolver/workflow-operator/task-author/doer 绑定：零改动（D2 缺省技能物化修复合入前运行时复验一次）。
- stale 信号处置变更：从（原设计的）队列条目改为巡检/策展人消费后产出 finding 卡报对话。

**知识中心 UI（/knowledge）**

- 布局：对话主界面（左，~60%）+ 右栏 wiki 视图（跟随对话渲染/可钉住/可切浏览模式全宽）+ 顶部健康条 + Ctrl+K 检索命令条。——**⚠️ 本条整体由 ADR-0033 换芯：wiki 主场恒定（左树+中正文+右栏三件套）+ 策展人抽屉（overlay 不重排，560px 可拖，多会话 tab/历史=客户端视图态，主通道 title=知识中心 唯一机器播报落点）+ 页头健康三槽弹层全量 + Ctrl+K。原文勿作为实现依据。**
- 会话复用既有 agent chat 通道（archive 分身会话，scope=knowledge），**不自建聊天基建**；前端订阅会话流 + 卡片协议（结构化事件→八类卡片渲染：抓取/来源摘要/编译 diff/归档编译/finding/回填/词条迷你/写保护）。
- 编译异步化：>10s 转异步任务，对话先回执、diff 卡完成后追加，卡片带流式状态与队列位次。
- 回滚：diff 卡按钮 → 服务端 git revert 单 commit + INDEX/LOG/FTS 重同步 + LOG 记 revert 行。
- 服务端 API 面（沿用 apiFetch/handleResponse 客户端模式）：ingest 投喂（url 抓取/上传/粘贴）、编译队列状态、revert、findings 列表与裁决、raw 只读、tree/article/search（org 参数钉 'global'）。
- 删除面：/wiki 路由与页面组件、/experience 整页（含经验库、知识管理 tab、审核组件、助手面板、偏好编辑器）；旧链接 404 或重定向 /knowledge。
- 主题沿用暗色 TUI（pop-* token），MarkdownPreview（sanitize 链）复用。

**迁移与幂等**

- 迁移脚本单入口、幂等、可重跑，顺序：全局搬家（wiki+.git）→ DB re-key/FTS 重建 → 重蒸馏（v2→v3，单 commit）→ LOG 换格式 → org knowledge/experiences 归档 → 删除（目录/表/路由）。每步 git 可回滚；旧 org wiki 路径兼容读一次（搬家窗口期）。
- 重蒸馏映射：projects/workflows 词条→topics 页（规则行入硬约束小节，锚点原号随迁）；business 词条→concepts 页；Glossary 蒸馏产物归并对应 concepts/entities；research 词条→concepts/sources；cases 原样保留；旧页整迁 _retired/v2/。

**治理产物**

- 新 ADR：「Karpathy 三层编译型知识库 + 审批废除」（amend org 级 wiki 与写入单一闸门前案）与「wiki 全局写串行」。
- GLOSSARY-MAP 更新（见 Further Notes）。

## Testing Decisions

**好测试的标准**：只断言外部行为——API 响应形状、文件系统产物（raw 冻结/页/INDEX/LOG/git log/锁文件）、provider 请求捕获（prompt 无注入文本、systemPrompt=persona）、DB 行、UI 渲染结果；不断言内部调用序列。禁止 Tautological Test：expected 值来自独立真相源（原型样例、Karpathy 原文格式、构造 fixture），不从被测实现反推。**并发断言必须真并发**：两路同时投喂，断言 git log 线性（无 merge commit）、LOG 时间线不交错、锚点无双花。

**验证策略绑定（故事簇 → Seam，全部复用既有缝，零新缝）**

| 故事簇 | 验证方法 | Seam |
|---|---|---|
| 19-25, 32-36, 39-41, 43：raw 冻结 / 多页编译 / 写串行队列+锁 / 重蒸馏 / 搬家 / 归档投喂 / LOG 换格式 / DB 迁移 | S1 服务层环级测试：真 fs+tmpdir，构造 raw fixture 断言编译产物（N 页/INDEX/LOG/git 线性）；并发双投喂断言串行；锁 stale 回收用假 PID；重蒸馏幂等=重跑 diff 为空；归档先于删除的顺序断言 | S1 knowledge/tasks 服务层（wiki-compile.test / wiki-migrate.test / task-lifecycle.test 先例） |
| 1-18(数据面), 42：ingest/队列/revert/findings/raw/tree/search API | S2 路由契约测试：形状/错误码/降级（抓取失败不落库、revert 后 INDEX/FTS 一致性）；findings 裁决即编译的端点行为 | S2 routes（wiki-routes.test / wiki-search-routes.test 先例） |
| 26-31, 37：注入链删除回归 / 指针行 / 阅读面 v3 / 双入口一致 | S3 engine 装配测试：mock provider 捕获——prompt 无注入文本、仅任务书+一行指针；precompute 零触发（E2E verify_pq 已证运行时形态）；存量流（无 as: / octopus_agent 委托）回归全绿 | S3 engine（agent.test / integration.test / task-doer-chat.test 先例） |
| 4-17(UI), 38：卡片渲染 / 排队状态 / 右栏联动与钉住 / 浏览模式 / Ctrl+K / 健康条口径 / 回滚钮 / 旧路由处置（联动/钉住/浏览模式三项随 ADR-0033 失效，S4 用例改写为「永不自动跳转」负断言 + 抽屉/药丸/多会话 tab 新断言） | S4 web 组件测试：mock API+会话流断言八类卡片、队列状态流转、健康条**无"待审核"**、/wiki 与 /experience 路由删除后行为 | S4 web-app（wiki-page.test.tsx / billing .test.tsx 先例） |
| 全链验收（≥1 票） | E2E 手工真跑（真 provider）：投喂真文章→raw 冻结→编译触 N 页→diff 卡→回滚→再投喂；并发双投喂串行化真测；归档一个真 task 自动投喂；agent 执行 JSONL 见 INDEX→v3 页 Read 序列 + wiki_refs 新锚点；复跑脚本化（e2e13-rerun.mjs 模式）+ 反假跑 R1-R8 | E2E（matt-e2e-test-methodology） |

**被测模块**：server knowledge 服务层（raw/编译队列/重蒸馏/迁移/巡检）、server 新路由、engine 装配（删除回归）、web-app /knowledge 组件群、core-pack skill 文本经 S3 装配断言间接覆盖（SKILL.md/SCHEMA.md 文本本体不做单测）。

## Out of Scope

- **P3 残余**：归档四路分流全量（skill 草案产出与授予链、语义摘要进 task metadata）；pending_review 表物理清理；工作执行侧自动案例提取（本期案例仍由策展人经对话/巡检入库）。
- **P4 残余**：effectiveness v2（JSONL 解析 ↔ blocker 关联、confidence 滚动更新——本期 confidence 仍为编译期静态值）；衰减自动退役（巡检只产 findings，采纳永远由人）；/agent 主对话与其他会话入口的"编进 wiki"意图路由（本期投喂入口 = 知识中心对话 + API）。
- 跨 org / 多 wiki / 全局-组织分层（D6 已终裁：全局唯一）。
- embedding 检索（不做，开关也不留）。
- wiki 页 Web 直接编辑（对话驱动策展人是唯一改页路径）；SCHEMA.md / user_preference.md 的任何自动改写。
- 经验库数据回流编译（数据已归档；将来要当 raw 素材由 owner 手动投喂，不做自动回流）。
- agent 记忆系统（daily/long-term/session）任何改动——不同域，零触碰。

## Further Notes

- **与 P0/P1 spec 的关系**：本 spec 是其 Out of Scope 中 P2（剔除注入链，经 p2-gate-pass.md 过闸）的承接 + P4 的策展人对话/UI 合并/巡检出口三项提前；P0/P1 spec 保留为 as-built 审计记录，不再修订。
- **前置 ops（M1 之前）**：P0/P1 分支合入 main——合前对 D2 修复（770d9fa6，缺省身份技能物化）跑运行时复验（e2e13 复跑脚本 + 一条无 skills 声明节点的断言：workspace .claude/skills 含 octo-wiki）。
- **新词条待入册**（按 domain.md 消费规则更新 GLOSSARY-MAP.md）：raw 层 (Raw Source)、五类页（实体页 Entity / 概念页 Concept / 主题页 Topic / 来源页 Source / 判例 Case 已有）、编译队列 (Compile Queue)、finding、回填 (Backfill)、知识中心 (Knowledge Center)、SCHEMA；修订词条：词条 (Entry)→页 (Page) 语义迁移、策展人 (Curator) 职责更新；废弃标注：审核队列、影子期（随注入链删除进入历史）、工作经验页。
- **原型冲突裁决**：`.scratch/knowledge-center/prototype.html` 为设计权威；本 spec 文字与原型冲突时以 spec 为准并回写原型（P0/P1 同款纪律）。
- **硬约束**：归档先于删除（一切数据）；agent 记忆域零触碰；K11 归档归并语义零触碰；保护端口 3000/3001/3098/3099 纪律照旧；wiki pre-commit 写权闸保留。
- **回滚故事**：本 phase 的每一步（搬家/重蒸馏/删除注入链/删除 UI）各自独立 commit 或独立迁移脚本步骤，可单步 revert；极端回滚 = revert 发布分支 + _archive 还原 org knowledge（过闸文书 §5 预案）。
