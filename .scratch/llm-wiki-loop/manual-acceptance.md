# 人工验收测试方案 — LLM-WIKI 知识闭环 P0+P1

服务已在运行：Web http://localhost:3210 · Server http://localhost:3211 · DB `~/.octopus/db/octopus.db`
wiki 根（独立 git 仓库）：`~/.octopus/orgs/xzf-dev/knowledge/wiki/`
⚠️ 验收全程切 org = **`xzf-dev`**（存量 19 词条 + 1 判例都在这；`default` 是空库）。

约定：每步 [ ] 勾选 = 通过。命令在 Git Bash 里跑。curl 前缀统一 `http://localhost:3211`。

---

## A. 数据面 · 只读可见（票01/03/05）— 故事 1-5,12,32

- [ ] A1 打开 http://localhost:3210/wiki ，左域树显示 4 个域：projects(2) / workflows(1) / business(16) / cases(≥1)，顶部健康概览条显示词条数/规则数/案例数/最近编译/待审核数。
- [ ] A2 点 `wf-prd-impl` → 中栏渲染正文 markdown；chips 显示 domain/stability/last_compiled/confidence；规则行有锚点（不可见 id）但**正文看不到行内日期**。
- [ ] A3 右元数据面板：sources 有 `doc:knowledge/workflows/prd-impl.md`、`archive:...`；git 近史 ≥1 条 compile commit；LOG 摘录非空。
- [ ] A4 顶部检索框输入 `构建` → 命中 `wf-prd-impl`（snippet「## 构建规则」，LIKE 降级正常，CJK 不断）。输入一个带特殊字符串如 `"错配` 不应 500。
- [ ] A5 curl 契约面自检（应与 UI 一致）：
      `curl "localhost:3211/api/knowledge/wiki/tree?org=xzf-dev"` → domains+stats+log
      `curl "localhost:3211/api/knowledge/wiki/article/wf-prd-impl?org=xzf-dev"` → sources/anchors/gitHistory
      `curl "localhost:3211/api/knowledge/wiki/search?org=xzf-dev&q=端口&topK=5"` → 命中且带 ruleRef 或锚点定位
- [ ] A6 `/wiki` 页**只读**：全页没有任何编辑/审核/删除按钮。
- [ ] A7 既有 `/experience` 的 KnowledgeTab 仍在、未被改动或合并（对照 PR 前）。

## B. 编译型知识库 · 格式与闸（票01/02）— 故事 6-9,32

- [ ] B1 wiki 根是真 git 仓库：`git -C ~/.octopus/orgs/xzf-dev/knowledge/wiki log --oneline` 有多条按域/源文件的编译 commit。
- [ ] B2 `INDEX.md`：llms.txt 风格（H1 + blockquote + 每域 H2 + 每词条一行摘要）；总长 ≤800 token（`wc`/目测），低频词条在 Optional 节。
- [ ] B3 `LOG.md`：一行一编译事件，表头 `|日期|动作|词条|摘要|来源|审核|`，动作为 compile/case+/revise/retire/split。
- [ ] B4 唯一写入口：手工往 wiki 词条文件外随便写一个 `.md` 不会被 API/检索读到（真源只在编译通道）。

## C. wiki lint 编译期闸 + 拆分（票02）— 故事 7,8

> 需要一个能触达编译通道的入口。走票06 审核 approve 或票05/07 迁移产物即可；构造超限样例走 API。

- [ ] C1 构造一个 >120 行 或 >25 规则 的词条尝试编译 → 被拒（error）+ 审核队列 `GET /api/review/summary` 的 `wiki` 桶出现一条 `wiki-split` 提案（按 H2 小节拆分）。
- [ ] C2 采纳该提案 → 词条变 hub 目录形态（hub README ≤40 行，子词条一行摘要+指针），导航 INDEX→hub→子词条 ≤3 跳，规则锚点跟随迁移、`[[wikilink]]`/案例 rule_ref 不断链。
- [ ] C3 正文含日期（非 cases 域）→ warn；>20 行代码块 → 被拦；断链由 INDEX 程序化重建自动修复（不打扰）。

## D. cases 判例域（票04）— 故事 15,16,20

- [ ] D1 域树 Cases 组显示已有判例（如 `case-e2e13-001`）。点开：五段（现场/诊断/根因/修复/教训）渲染；状态 chip = open/distilled/superseded 之一。
- [ ] D2 判例正文**允许**含日期（区别于规则域）；文件名 `{YYYY-MM-DD}-{slug}.md`。
- [ ] D3 检索 `domain=cases` 且按症状词（如 `LOCKFILE` 或 `失配`）→ 命中该判例，结果带 rule_ref 指针；点 rule_ref 顺藤跳到对应规则词条并高亮。
- [ ] D4 append-only：判例入库后正文不可改写，仅 status/rule_ref/occurrences 可经编译通道更新（尝试改正文应被拒并留 LOG）。

## E. 策展写闸 · 单一闸门技术强制（票06）— 故事 14

- [ ] E1 审核队列 approve 一条 `rule`/`wiki-edit` → 词条更新 + 一次 git commit + LOG 行，三处一致；commit message 带 `[review:<pending-item-id>]`。
- [ ] E2 编译≠追加：approve 走的是过 lint+合并的编译通道（没有 appendFile 旁路）。
- [ ] E3 旁路写权被拒：在 `OCTOPUS_WIKI_COMMIT_SOURCE` 缺标记下对 wiki 仓库直接 commit → 被 pre-commit hook 拒绝；带 `curate`/`manual` 标记才放行。
      试验：`cd ~/.octopus/orgs/xzf-dev/knowledge/wiki && echo x > t.md && git add t.md && git commit -m x`（应被 hook 拒），`git reset` 清理。
- [ ] E4 `user_preference.md` 永不进自动写：策展通道对它只出「建议→人确认」，无自动改写。
- [ ] E5 技能隔离：`octo-wiki-curate`（写侧）只在 archive 分身可见；其它分身/消费侧工作区 `.claude/skills` 里查不到它。

## F. 蒸馏迁移（票07）— 故事 12,13

- [ ] F1 触发蒸馏命令（`POST /api/knowledge/wiki/distill?org=xzf-dev`，docs/research + docs/adr）→ 审核队列出现 research/business 候选，每条 sources 带 `doc:<path>` 可回跳原文。
- [ ] F2 幂等：重跑蒸馏不重复入队（源文件指纹去重）。
- [ ] F3 采纳一篇 → 经策展写闸编译上线 → `/wiki` research/ 域可见、指针回跳；拒绝项留档不写入。
- [ ] F4 原文 `docs/research/*`、`docs/adr/*` 正文零改动（git status 里 docs 目录无 diff）。

## G. 执行身份 as: + IdentityResolver（票08/09/10）— 故事 21-25,28

- [ ] G1 YAML 里 agent 节点写 `as: workflow-operator` → 执行日志/产物体现该分身 persona 与 skills；cwd 不变（工作现场仍是节点原 workspace）。
- [ ] G2 `as: <不存在的代号>` → 引擎初始化即被硬闸拒绝（不等跑起来才失败）。
- [ ] G3 缺省：agent 节点**不写 as:** → 自动装配 workflow-operator，存量工作流零改动即获得身份。
- [ ] G4 内置分身列表 API/UI 第 8 个 = workflow-operator（显示名「工作流工程师」），不可删除。
- [ ] G5 版本钉住：`as: workflow-operator@1.0.0` 可解析到已发布快照（agent_versions）。
- [ ] G6 loop/swarm/sub_workflow 子引擎内 agent 节点继承同一装配语义。

## H. octo-wiki 查阅通道（票11）— 故事 17-20,26,27,29

- [ ] H1 执行预检后，工作区 `.claude/skills/octo-wiki/SKILL.md` 真实存在（SDK 原生发现，非 prompt 注入）。
- [ ] H2 缺省 operator 节点（不声明 skills）也能把 octo-wiki 物化进工作区（= 修复后的 D2；这是验收重点之一）。
- [ ] H3 task-doer 任务上下文含**一行恒定指针**（wiki 根路径 + 查阅纪律），长度 ~50 token 级，**不含任何知识正文**。
- [ ] H4 技能内路径口径与 wiki 根（orgs/ 布局）一致；search API 端点与票03 契约一致。

## I. 影子双轨 · wiki_refs · 对照导出（票12）— 故事 30,31

- [ ] I1 跑一条 `knowledge.mode=both`（默认）的执行 → 注入链照常运行（旧行为不变）同时查阅行为被记录。
- [ ] I2 执行者产出的 `wiki_refs` 经 vars_update 落 VarPool → JSONL + `executions.var_pool`（DB）可查；`stale:` 前缀条目单独可筛。
      验证：`sqlite3 ~/.octopus/db/octopus.db "SELECT var_pool FROM executions WHERE var_pool LIKE '%wiki_refs%' ORDER BY rowid DESC LIMIT 3;"`
- [ ] I3 影子对照导出：`GET /api/workspaces/:id/executions/:executionId/shadow-compare` → 四象限（hit/miss/injectOnly/queryOnly）+ 注入侧 `__relevant_rule_ids`（只读）并排查阅侧 wiki_refs。（注：旧 id 体系 vs 新 `entry#oct-NNN` 体系不同 → hit 恒空属预期数据面，正是 P2 要看的对照。）
- [ ] I4 mode=inject → 不记录 wiki_refs；mode=query → 注入链不跑（precompute 不执行）。回滚开关：mode 回 inject 即完全恢复现状。

## J. 注入链零改动（红线复验，贯穿）

- [ ] J1 本期任何验收步骤都未改变旧注入行为：对照 PR 前，工作流启动仍产出旧 `__relevant_rule_ids` 注入结果（既有 prompt-enhance/knowledge 注入测试一字未改仍绿可作旁证）。
- [ ] J2 抽查源文件确属未动：`git diff origin/main...HEAD -- '**/prompt-injector.*' '**/knowledge-injector.*' '**/precompute.*'` 应为空。

## K. 闭环首跑（票13 复验，端到端）

- [ ] K1 用真 provider 跑一条含 agent 节点（显式 as 或缺省 operator）、任务必然触发查阅的工作流。
- [ ] K2 JSONL 出现 INDEX.md → 词条的 Read 工具调用序列（遵循导航协议，非跳 INDEX 的 glob）。
- [ ] K3 wiki_refs 落 VarPool/DB，引用锚点 id 在词条中真实存在。
- [ ] K4 `/wiki` 页可浏览被引词条，元数据 sources/git 近史非空。
- [ ] K5 shadow-compare 含该 executionId 的真实对照行。
- [ ] K6 回归：一条不含 as: 的既有工作流跑通；一条 octopus_agent 节点工作流的重量级委托（Task Contract+结构化返回）不变。
> 可复跑脚本（票13 已验证 9/9）：`node C:/tmp/llm-wiki-notes/e2e13/e2e13-rerun.mjs 3211`（如脚本里端口写死 3411，改传当前 server 端口）。

## L. 已知遗留（验收时不算失败，供确认口径）

- approve 的 HTTP 响应**当前丢弃 L6 规则形态告警**（告警仍进 LOG/编译流程，只是没回给调用方）。
- `writeCase` 与 `compileEntry` 编译管线有结构性重复；domain 清单在多处内联（技术债，行为正确）。
- 「编译型知识库」第二份 ADR 未补（spec 标为建议）。
- 判例暂无 HTTP 写入口（P3 计划内）；本库判例经唯一写闸 compileEntry 入档。
