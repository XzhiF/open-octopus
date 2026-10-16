# E2E Test Report — 知识中心 票15 全链真跑验收（P2' 集成认证）

## Basic Info

- Target: 知识中心全链五链（投喂主链 / 并发串行 / 归档投喂 / 消费 / 反哺）+ 旧路由处置，票 01–14 集成
- Mode: API Integration + 真实 provider 工作流执行 + JSONL/DB/FS/GIT 五面交叉验证（matt-e2e-test-methodology · e2e-harness 复现模式）
- Host: `C:\xzf\ai\open-octopus\.worktrees\kc-int` @ `1fda3e4e`（feat-knowledge-center-20261013，已 build；E2E 全程未 commit，收尾 tracked 文件 `git status` 干净，未跟踪 `packages/server/dist-scripts/` 为票 05/10 驱动既有产物）
- 环境: dev 实例 `pnpm dev --port 3410,3411 --skip-build`（web=3410 server=3411，pid 40352，`mode=isolated branch=feat-knowledge-center-20261013`；保护端口 3000/3001/3098/3099 未触碰）
- 知识根: **全局真根 `~/.octopus/knowledge`（真盘真 git）**——E2E 写入即生产沉淀，本 phase 判例同 e2e13 先例保留为审计面（17 新 commit + 8 raw fixture，`kc15-` 前缀可识别，声明见「清理与残留」）
- DB: **默认库 `octopus.db` 全程零直写**（mtime Oct 13 22:44 早于实例启动 22:51；脚本所有 SQL 显式指向分支库）。实例走分支库 `octopus-feat-knowledge-center-20261013.db`（VACUUM 播种自 ops 后默认库；保留审计）
- 复跑: `node C:/tmp/kc-e2e15/kc15-rerun.mjs all --run <tag>`（本轮实跑两遍全绿：pass1 tag=`1791903766361` 78/78 断言、pass2 tag=`20261013P2` 79/79；分步 `gate/chain1a/…/web` 供前台单段 <600s）
- 证据总集: `C:/tmp/kc-e2e15/evidence/`（API 原行 JSON 快照 / results-*.json / dev.log / state/*.json）
- Timestamp: 2026-10-13T14:51Z 起（各步 ISO 见 evidence）

## Provider 真跑闸（反假跑前置）

- `ANTHROPIC_API_KEY` 未设；`~/.claude/settings.json` env 段 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`（Anthropic 兼容真端点）；`OCTOPUS_MOCK_PROVIDERS` 未设
- 真实连通证明①：`POST /api/system/models/test` → `{"provider":"claude","model":"sonnet","success":true,"latency":6183}`（首跑闸）、`{"model":"sonnet","success":true,"latency":4861}`（pass2）、haiku 4451/4318（latency 全非零）
- 真实连通证明②：链④ 执行 JSONL `turn_usage` 原行（kc15-consume-20261013P2，turn2）：
  `{"event":"agent_event","event_data":{"type":"turn_usage","turn":2,"delta":{"inputTokens":6,"outputTokens":448,"cacheReadTokens":33433,"cacheCreationTokens":2261},"cumulative":{"cacheReadTokens":33433,"cacheCreationTokens":35694}}}` —— 含 cache 记账的真实推理流
- 策展人编译/归档总结/finding 修订全部真 sonnet 跑：165.4s / 315.6s / 170.3s / 135.3s / 115.2s / 66s（dev.log 计时可查）
- 观察：pass2 首 ping 一次 `success:false "Operation aborted"`（12s，端点瞬时抖动），重试即过；非产品缺陷

## 执行矩阵

| # | 链 | pass1(1791903766361) | pass2(20261013P2) | 关键量 |
|---|---|---|---|---|
| 0 | gate+web | 4/4 + 4/4 | 4/4 + 4/4 | 隔离实例 / 307×2 / /knowledge 200 |
| 1 | 链① 投喂→编译→回滚→再投喂 | chain1a 12/12 + chain1b 10/10 | chain1a 11/11 + chain1b 14/14 | 触 6 页 bf6928d→revert 40bba23→再编译 e5027f7；pass2 REVERT_CONFLICT 契约分支 + paste 深环 a77fc9a→f6ae7ca→28d1621 |
| 1f | 链① 前置失败×2（真缺陷入册） | crt-…001/002 failed（L5 闸） | — | 失败事务零副作用（git 干净/锁释放/队列续） |
| 2 | 链② 并发串行 | 2/2 + 7/7 | 2/2 + 7/7 | depth=2 running+queued#1；+2 commit；LOG 两条完整不交错、顺序=完成序；锚点 22→30 全库唯一 |
| 3 | 链③ 归档投喂（真任务 v4→done） | 3/3 + 10/10 | 1/1 + 10/10（产物再验） | dd48c3a5 accepted→done；task-…-summary.md 四段+hash；arc- committed op=archive-compile；commit 73cffb3 触 4 页 |
| 4 | 链④ 消费+回归 | 3/3 + 12/12 | 3/3 + 12/12 | JSONL INDEX 第一跳→topics 页整读；wiki_refs 4+1 真锚点；[ref:] 原行；injectSide 恒空；回归(a)(b) completed |
| 5 | 链⑤ 反哺闭环 | 4/4 + 7/7（含首跑 8 断言轮） | 4/4 + 7/7 | patrol 45 findings（stale 1）；fnd-12900b05 adopt→66a45ff resolved；Lane A `✅ finding 裁决回执…```kc-card`；openFindings 45→44→43 联动 |

## 链① 证据原行（投喂→冻结→编译 diff 卡数据面→回滚→再投喂）

- 抓取冻结（`POST /api/knowledge/ingest?compile=true`，真文章 Paul Graham essay 18.9KB→md 12266B；pass1 原行）：
  `{"raw":{"path":"raw/inbox/2026-10-13-kc15-chain1-article.md","hash":"<sha256>","bytes":12266,…},"deduped":false,"compileTask":{"taskId":"crt-20261013T1507-003","status":"queued"}}`（evidence/chain1-ingest.json；front-matter `hash: "…"` 与指针互验，正文 payload 实算 sha256=hash）
- 编译 diff 卡数据面（`GET /wiki/compile/task/{id}` → `result`，票05 判据）：`status=committed touched=6 created=6 contradictions=0 commit=bf6928d8622f…`（315.6s 真 sonnet；单 commit 含 `INDEX.md,LOG.md,concepts/con-*,entities/ent-paul-graham.md,…`，git show 原行见 evidence/chain1-compile-task.json）
- SCHEMA.md 首编译自动 seed 知识根（票15 断言；`ensureSchemaDoc` 于 curator.ts:348 编译前必读）：`C:/Users/EDY/.octopus/knowledge/SCHEMA.md` 在盘 ✓
- sources 回指可解析（机械正则取行）：`- raw: raw/inbox/2026-10-13-kc15-chain1-article.md` + `- sha256: <64hex>` 与 raw 实算互验 ✓；`GET /wiki/search?q=<stem>&org=global` FTS 命中 ✓
- 回滚（`POST /api/knowledge/wiki/revert {commit:bf6928d}` → 202 `rvt-…` → committed）：
  - git：`40bba23 revert: bf6928d — 回滚本次编译`（线性，`rev-list --merges`=0）
  - LOG 末行：`## [2026-10-13] revert | compile bf6928d`（票11 行格式契约）
  - 重同步：sources 页从 INDEX 摘除 + 文件不在盘 + `GET article/src-…=404` + `wiki_articles domain='source' COUNT=0`（四路同查）
  - **实测语义钉出**：git revert 会撤掉原 compile LOG 行再 append revert 行——时间线净行数不变（审计真相面=revert 行+git 史；观察 D-kc15-3）
- 再投喂：同 URL → `deduped=true` 同 hash 回指针（票02 幂等契约）；编译因回执页已被回滚**必走真编译**：`touched=5 commit=e5027f7`（135.3s）；二次环 `a77fc9a→f6ae7ca(revert)→28d1621` 同型（pass2）
- 前置缺陷现场（D-kc15-1，真失败非假跑）：Karpathy gist 源连投两次真编译失败原行：
  `COMPILE_FAILED: L5_DATES_IN_BODY: concepts/con-llm-wiki-pattern.md: 正文出现日期 '2026-10-13'——常青正文应零日期`（attempt1 165.4s）、`'2026-04-02'`（attempt2 215.4s，源正文自带日期）
  失败语义全绿：`git status` 空、无半成品页、`.compile.lock` 不存在、队列 `depth=0` 续跑、raw 保留冻结（`rawSources=1`）——票06「失败→事务回滚→释放锁→队列继续」实证

## 链② 证据原行（真并发串行化）

- 两路 `Promise.all` POST ingest?compile=true（paste 唯一 nonce 源，间隔 0.x s 双 taskId）：`crt-…-006 / crt-…-007`
- 队列位次（`GET /wiki/queue` 原行，pass1）：`{"depth":2,"running":true,"tasks":[…,{"state":"running","position":null},{"state":"queued","position":1}]}` → 「排队中 #1 → 编译中 → 已提交」数据面 ✓
- 落库三断言（票面/spec 故事40）：
  - git：`rev-list --count --merges HEAD`=0 且 rev-list delta=+2（一编译一 commit）
  - LOG：新 header 恰 2 行且各自紧跟 `  → 结果` 续行（无撕行）；`note A` 行在前 ⇔ 其任务 finishedAt 早（完成顺序一致）
  - 锚点：topics 全库 `<!--#oct-NNN-->` 22 枚（pass1）→30 枚（pass2）Set==len 无双花

## 链③ 证据原行（真实 task 走 v4 链归档→自动投喂）

- 选存量任务 `dd48c3a5`（phase1 round1 执行 abcf00cb 已 completed → 派生 awaiting_review）：
  `POST /api/tasks/dd48c3a5…/acceptance {"phase_index":1,"round_index":1,"decision":"accepted"}` → `200`，响应 task.status=**done**（beginArchiving→K11 快路径成功；`completed_at=2026-10-13T15:26:51.804Z`）
- 归档自动投喂（beginArchiving 先于 K11 编排 fire-and-forget，tasks-service.ts:2760-2764）：
  - `raw/archives/task-dd48c3a5-…-summary.md` 落盘：front-matter `origin: "task-archive:<id>"` + `hash` 与正文实算互验；四段小节齐（验收台账/关键决策/踩坑/产出指针，票10 AC1）
  - `GET /wiki/queue/task/arc-dd48c3a5…` → `{"state":"committed","opKind":"archive-compile","label":"raw/archives/…"}`（入全局串行队列）
  - 编译产物：`sources/task-…-summary.md` 回指 raw+sha256；wiki commit `73cffb3 ingest: Sorkflow的Agent节点优化 — 归档总结 — 触 4 页 · 新页 3 · 矛盾 0`
- K11/done 语义不变：投喂链零写 tasks.status/completed_at（done 由 endArchiving 唯一写者）；pass2 复验=账本一次决定（append-only，禁二次验收）+ 产物 fs/git 再验全绿

## 链④ 证据原行（消费 v3 + 存量流回归 + 零注入）

- 消费流 `as: workflow-operator` + `skills:[octo-wiki]`，exec `2a4f69a3`/`416fb856` **completed**×两 pass
- JSONL Read 序列原行（wiki-consume.jsonl）：`…/knowledge/wiki/INDEX.md`（第一跳）→ `topics/prj-open-octopus.md` → `topics/wf-prd-impl.md`（v3 页整读，禁 glob 合规）
- 产出 [ref:] 原行：`{"event":"text_block","content":"…[ref: wf-prd-impl#oct-008]…[ref: prj-open-octopus#oct-007]…[ref: wf-prd-impl#oct-014]…"}`
- `executions.var_pool` 原行：`"wiki_refs":["wf-prd-impl#oct-008","prj-open-octopus#oct-007","wf-prd-impl#oct-014","wf-prd-impl#oct-015","stale:wf-prd-impl#oct-008 当前已改 watch 模式无需手动 build"]` —— 每个 `页id#锚点` 盘上双存在断言（`id:` + `<!--#anchor-->`）全过；**agent 真流自发上报 stale，无需注造兜底**（窄口：stale 恰 1 条与指令一致）
- 零注入：var_pool 键集=`execution_name,workflow_name,wiki_refs`（`__relevant_rule_ids/__user_preference_text/__injected_rule_ids` 零存在）；shadow-compare 原行 `"injectSide":{"relevant":[],"injected":[]}`（spec 行104 注入侧冻结空）
  - **P4 票05 追加注记（2026-10-15 · 红线4「归档先于删除」）**：shadow-compare 端点已于 P4 删除，数据面见本文件存档原行（上方「shadow-compare 原行」即当时快照）。删的是端点不是审计链。本注为追加，未改写原文。
- 回归：(a) 无 `as:` plain 节点 completed `{"last_output":"kc15-regression-ok"}`；(b) `octopus_agent` 委托 task-doer completed，outputs 含 `session_id/agent_name:"task-doer"/last_output:"kc15-delegated-ok"`
- 浏览器面（同先例口径，渲染级由 S4 组件测试 38/38 覆盖）：`GET /knowledge` 200（27421B）；INDEX 五类树/tree API domains=5

## 链⑤ 证据原行（stale→finding→裁决→修订编译→回执）

- `POST /api/knowledge/patrol` 原行：`{"scanned":{"pages":27,"executions":1},"counts":{"orphan":11,"missing-xref":33,"stale":1},"newFindings":45,…}`（即时「体检」面）
- `GET /api/knowledge/findings?status=open`：`{"id":"fnd-12900b05cdd3ff13","kind":"stale","title":"stale 上报：topics/wf-prd-impl.md#oct-008（1 次执行反馈）","status":"open","source":"patrol"}` —— 消费侧信号 → 生产侧 finding 闭环（故事29）
- 裁决即编译：`POST /findings/fnd-12900b05…/adopt` → 202 `fft-…`（opKind finding-fix 入全局队列）→ committed(66s 真 LLM seam+锚点守门) → wiki `66a45ff compile: stale 上报：… — finding 采纳修订 stale · 裁决即编译（票13）`；finding→resolved；目标页锚点未失（FINDING_ANCHOR_LOST 未触发）
- Lane A 回执卡数据：会话消息表原行 `✅ finding 裁决回执（采纳修订已编译）：缺互链：… → resolved` + fenced ` ```kc-card ` 块（serializeKcCardBlock 契约；会话经 `POST /api/agent/sessions`+PUT 标题「知识中心」真实通道）
- 健康条真实联动（非恒零）：openFindings 0→45→44→43（巡检/裁决逐拍）；queueDepth 链⑤慢编译在跑期 ≥1（pass1 首采）、快路径经 `GET /wiki/queue/task/fft-…` 全局队列在案行证可观测
- 幂等再验：pass2 patrol `newFindings=2`（存量 upsert 不重报）；已 resolved 的 stale 保持保态（内容寻址 id upsert「保人已裁决」票13 语义）；ignore 端点面=票13 S2（本轮未真跑）

## 旧路由处置

- `GET /wiki` → **307** Location `/knowledge`；`GET /experience?sub=lib` → **307** Location `/knowledge`（query 剥除）；`GET /knowledge` → 200（票09 middleware 契约 S4×4 的运行时复证）

## 回归

- 注入链删除面（票08/09 承接）：链④ 零注入键 + injectSide 恒空 + prompt 无规则文本（JSONL 观察）
- 存量流：plain 无 as 节点、octopus_agent 委托 task-doer（Task Contract 结构化返回）两 pass 全 completed
- 消费锚点旧号随迁可用：oct-007/008/014/015 重蒸馏后仍解析（故事28）
- K11 归档编排：acceptance→archiving→done 真跑一次通过（completed_at 由 K11 写）；投喂链零干预

## 缺陷发现（真缺陷如实入册；quick fix 范围外一律 DEFER）

**D-kc15-1（DEFER，robustness）——含日期的一手源恒失败于 L5 硬闸，API 编译面无 lint 自纠循环。**
Karpathy llm-wiki gist（票05 当日同一 URL 曾一把过 10 页）今日两连真编译失败，均为 `L5_DATES_IN_BODY`（LLM 反复把源内日期写入常青概念页）。票05 裁定④自纠仅覆盖「计划校验」，lint 拒绝即任务终态；票12「对话内自纠」是分身行为面，REST/队列面无重试通道。失败语义本身干净（零半成品/锁释放/队列续跑）。建议：服务层对 DATES/L5 一轮改写自纠，或抓取卡带「重试编译」入口。本轮以无日期权威文章完成链①（不硬修=越权）。

**D-kc15-2（DEFER，spec 兑现缺口）——INDEX「必读」节 `user_preference.md` 路径歧义。**
`INDEX.md` 必读行列 `- user_preference.md — owner 偏好（人工维护）`，但文件实在**知识根**（`~/.octopus/knowledge/user_preference.md`），wiki 根下无此文件；链④ agent 尝试 `wiki/user_preference.md` → File not found 并在产出中如实报告（JSONL text_block 原行存档）。票14「INDEX 必读节承接 user_preference 全文必读语义」只成了一半（语义在场、路径不可达）。建议 INDEX 程序化重建器标注 `../user_preference.md（知识根）`。

**D-kc15-3（DEFER，观察/改进建议）——回滚干净窗仅限 HEAD-adjacent。**
目标 compile 之后若又有 commit 触及 INDEX/LOG 共行（每编译必触），`git revert --no-commit` 三方合并冲突 → `REVERT_CONFLICT`（票12 文档化错误码，行为=契约，零副作用实证：HEAD 不动/工作区净/队列续）。产品「一键回滚本次编译」主场景成立；任意历史 commit 深回滚需改为「按目标态程序化重建 INDEX/LOG」实现（改进单）。另 revert 会撤原 compile LOG 行再 append revert 行（时间线净行数不变），审计真相面=git 史，建议文档写明。

**D-kc15-4（DEFER，安全面备案）——`/api/agent/*` Bearer 占位校验只验在场。**
`agentAuthMiddleware`（middleware.ts:95-108）任何 `Bearer <任意串>` 即过——开发态合理，**生产部署前需接真鉴权**（知识中心会话通道依赖此面）。E2E 经占位头建「知识中心」会话（Lane A 回执落位），如实记录。

**环境注记（非缺陷）**：pass2 首 ping 一次 `Operation aborted`（重试即过）；`pnpm dev` 起 web 前须先清 34xx 僵尸（本轮 netstat 预检后直接起，无触发）；Next 16 `middleware` 约定 deprecated 警告（307 功能正常）。

## 43 故事 → 证据映射（verification-report 素材）

| 故事 | 主题 | E2E 证据指针 | 判定 |
|---|---|---|---|
| 1 | URL 投喂入库 | 链① ingest?compile=true 200+真编译 | PASS |
| 2 | 粘贴/文件投喂 | 链② text 模式×4 源、链① pass2 paste | PASS（file 模式=票02 S1/S2） |
| 3 | 抓取卡 path/大小/hash | 链① ingest 响应 raw{path,bytes,hash}+互验 | PASS（数据面；渲染=S4） |
| 4 | diff 卡明细/冲突/commit | 链① compile result touched=6/contradictions=0/commit | PASS |
| 5 | 一键回滚 | 链① revert committed+四路重同步断言 | PASS（深回滚窗=D-kc15-3） |
| 6-7 | 右栏跟随/钉住 | 渲染面 S4 覆盖（票12 32/32+票13 38/38） | 不在 E2E 面（声明） |
| 8 | 浏览模式 | tree API domains=5 + /knowledge 200 + INDEX 五类 | PASS（数据面） |
| 9 | Ctrl+K 检索 | search API FTS 命中（链①）+票11 S2/S4 | PASS（数据面） |
| 10 | 健康条口径+无待审核 | health 原行字段齐（pages.byType/rawSources/ingestedThisWeek/openFindings/queueDepth/lastCompiled/gitHead），**无 pendingReview 键**；联动非恒零（链⑤） | PASS |
| 11 | 排队中 #N→编译中→已提交 | 链② queue 快照 running+queued position=1 | PASS |
| 12 | finding 三钮裁决即编译 | 链⑤ adopt→66a45ff→resolved；ignore=票13 S2 | PASS-adopt（ignore 留档） |
| 13 | 「体检一下」即时巡检 | 链⑤ POST /patrol counts{orphan11,xref33,stale1} | PASS |
| 14 | 回填卡 [编进 wiki] | 票13 S1/S2（raw 冻结 origin=chat:）| 不在 E2E 面（声明） |
| 15 | 归档自动编译卡 | 链③ raw summary 四段+arc committed+73cffb3 | PASS |
| 16 | user_preference 只读渲染 | GET /preference 面票09/11 S2；INDEX 必读路径=D-kc15-2 | PARTIAL（DEFER 注记） |
| 17 | LOG 时间线可 grep | 链①② `^## [date] op \| title` 行格式断言 | PASS |
| 18 | 全局唯一无 org | health/tree/search/article 全钉 org=global | PASS |
| 19 | 编译前必读 SCHEMA+INDEX | SCHEMA.md 首编译 seed+盘上在场；curator 编译前必读=代码缝（S1 钉） | PASS（间接） |
| 20 | 全文读 raw→diff→一 commit 触 N 页 | 链① bf6928d 单 commit 含 N 页+INDEX+LOG | PASS |
| 21 | 矛盾标记报 finding 不静默 | 本轮 contradictions=0 未触发；=票05 S1 | 不在 E2E 面（声明） |
| 22 | sources 摘要页回指 raw+hash | 链①③④ sha256 实算互验 | PASS |
| 23 | lint 拒绝对话内自纠 | **D-kc15-1：API 面失败终态无自纠** | REVIEW |
| 24 | 人工文件写保护 | 票12 wiki-write-gate S1/S4 | 不在 E2E 面（声明） |
| 25 | 一切写经 FIFO+根锁 | 四 opKind 同队串行（ingest-compile/archive-compile/finding-fix/revert）+失败锁净 | PASS |
| 26 | 五类页查阅 | 链④ JSONL topics 整读序列 | PASS |
| 27 | 导航协议不变 | 链④ INDEX 第一跳+禁 glob 合规（search 兜底=票11） | PASS |
| 28 | 旧锚号迁移可解析 | oct-007/008/014/015 盘上双存在 | PASS |
| 29 | stale 上报成 finding | 链④ agent 真流 stale→链⑤ fnd-12900b05→adopt→commit | PASS |
| 30 | 恒定指针行 ~50 token | 票08/14 S3 装配钉死；E2E 以零注入+闭环间接 | PASS（间接） |
| 31 | prompt 零注入文本 | 链④ var_pool 键集+injectSide 恒空 | PASS |
| 32 | raw 落盘冻结只读 | hash 互验+dedup 幂等回指针（链①③） | PASS |
| 33 | wiki 连 .git 搬家史连续 | 基线 HEAD 492c67d 延续，本轮 17 commit 线性 | PASS |
| 34 | 重蒸馏 v3 幂等单 commit | ops 证据 `C:/tmp/kc-ops/rs-*.json`+本轮锚续用/唯一 | PASS（间接） |
| 35 | LOG 换行格式 | 基线行+本轮全 `## [` 新格式 | PASS |
| 36 | 归档先于删除 | ops 证据 `C:/tmp/kc-ops/teardown-*.json`（主控执行） | PASS（ops 面） |
| 37 | 注入删净双入口零回归 | 链④回归(a)(b)+零注入 | PASS |
| 38 | 旧路由处置 | 307×2→/knowledge + 200 | PASS |
| 39 | 锁 stale 回收 | 票06 S1 假 PID 钉；E2E 证失败后 `.compile.lock` 不在盘 | PASS（间接） |
| 40 | 并发串行硬保证 | 链② 三断言×两 pass | PASS |
| 41 | DB 索引层平滑切五类 | health pages.byType=entity/concept/topic/source/case 全类非零（32 页）| PASS |
| 42 | 夜巡 findings 报对话 | 即时巡检+Lane A 回执实证；cron 本体=票13 S1/scheduler | PASS（即时面） |
| 43 | 归档态自动投喂不阻塞 done | 链③ 全绿（done 先于编译完成，K11 零触碰） | PASS |

## 反假跑核查 R1-R8

- [x] R1 真服务：pid 40352 dev 实例真进程，health `mode=isolated branch=feat-knowledge-center-20261013`（gate 原行）
- [x] R2 业务断言：157 条断言全字段级（touched 数/hash 互验/commit/LOG 正则/键集/状态流转），非 200 即过
- [x] R3 交叉验证：API↔FS↔DB↔git↔JSONL 五面（链① compile.result↔INDEX↔git show↔wiki_articles↔search；链④ JSONL↔var_pool↔shadow；链③ queue↔raw↔commit↔task 行）
  - **P4 票05 追加注记（2026-10-15）**：链④「shadow」面的 shadow-compare 端点已于 P4 删除，数据面见本文件存档原行（链④ 证据原行小节）。本注为追加，未改写原文。
- [x] R4 证据 ≥2：每链 ≥3 类原行（见各「证据原行」+evidence/ 快照）
- [x] R5 副作用验证：写链 commit+DB+FTS 齐验；**失败链零副作用**（L5 两败 git 净/锁无/队续）；revert 链四路摘除互验
- [x] R6 真实通路：知识 API 无鉴权面=产品现状；/api/agent Bearer 占位=D-kc15-4 入册；provider 走 settings 真 token 真网络（latency 实测+JSONL cache 记账）
- [x] R7 数据隔离+可识别：全部 `kc15-*` 前缀（raw/LOG/commit 标题/workspace 名）；**审计面保留不删**（真 git 真盘=生产沉淀，同 e2e13 先例口径的偏差声明）；默认库零直写（mtime 对质）
- [x] R8 可重跑：`kc15-rerun.mjs` 两遍实跑全绿（pass1 78/78、pass2 79/79）；链③任务态转换=账本一次决定（产品不变式），重跑 pass 自动转产物再验（脚本内声明）；新环境从零=见复现步骤

## 复现步骤

1. `cd C:\xzf\ai\open-octopus\.worktrees\kc-int`（@1fda3e4e 已 build）；netstat 34xx 扫僵尸
2. 分支库就位（或重播种）：`sqlite3 ~/.octopus/db/octopus.db "VACUUM INTO '~/.octopus/db/octopus-feat-knowledge-center-20261013.db'"`（默认库只读源）
3. `pnpm dev --port 3410,3411 --skip-build`；`node C:/tmp/kc-e2e15/kc15-rerun.mjs gate --run <tag>`（4/4 含真 ping）
4. 全链：`KC15_ARTICLE_URL=https://paulgraham.com/ff.html node C:/tmp/kc-e2e15/kc15-rerun.mjs all --run <tag>`（单条命令全链；LLM 编译多，约 20-30min；分步模式链1a/1b/2a/2b/3a/3b/4a/4b/5a/5b/web 各 <600s，state 续跑）
   - 注：默认 gist URL 触发 D-kc15-1 恒失败场景（保留复现价值）；链①深跑请用 env 换无日期文章
   - 注：链③依赖分支库存量任务 `dd48c3a5`（pass1 已裁决；重跑自动转产物再验；全新播种可再真跑转换）
5. 期望：各 results-<phase>-<tag>.json `ALL PASS`；wiki git log 见 ingest/revert/finding-fix 线性史
6. 拆机：`pnpm kill:port 3411; pnpm kill:port 3410` → `netstat -ano | findstr "3410 3411"` 复核（三段式）

## 清理与残留

- 端口：拆机三段式**已执行**——`pnpm kill:port 3411`（Killed PID 40352）→ `pnpm kill:port 3410`（Killed PID 9152）→ `netstat` 复核 `CLEAN: 3410/3411 free`；保护端口 3000/3001/3098/3099 全程无监听未误伤。注：后台任务包装先被终止而 server/web 进程残活（孤儿监听），kill:port 正解收尸=windows-bash 三段式教科书案例
- worktree：tracked 文件零改动未 commit；`dist-scripts/` 未跟踪件为票05/10 既有产物，不新增
- 保留（审计面，真 git 真盘=生产沉淀声明）：wiki 17 commits（bf6928d…36d605e，含 revert 两枚）、raw 8 件（karpathy gist 冻结件×1 + kc15- 前缀×7）、`SCHEMA.md` seed 件、任务 dd48c3a5 台账行（accepted，status=done）、分支库 `octopus-feat-knowledge-center-20261013.db`（执行行/finding 行/会话回执行）、fixture workspaces `kc15-*`×4、知识中心会话（archive clone）+kc-card 消息
- 默认库 `octopus.db`：全程只读（实例经 dev.mjs 隔离走分支库；脚本 SQL 显式分支库路径）
- `~/.octopus/knowledge/raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md`：两次编译失败的源本身**保留不可变**（raw 层冻结契约，失败不删源）

## Conclusion

**PASS-WITH-DEFECTS（GO 口径）** — 五链 + 旧路由处置全部真跑通过：157 条断言、两遍复跑全绿（78/78 → 79/79），真 provider（含 cache 记账）、真 git（17 commit 线性、无 merge、revert 干净窗）、真 fs（raw 冻结/四同步/锁回收）三真齐。K11/done 语义、注入链删除、存量流回归零破坏。四条缺陷入册（D-kc15-1 lint 自纠缺失×日期源、D-kc15-2 INDEX 必读路径歧义、D-kc15-3 深回滚契约窗、D-kc15-4 agent Bearer 占位），全部 DEFER 不现场越权修；无假跑成分。phase 级 GO 建议：合入 main 时随 PR 附本报告 + 缺陷四单转后续票。
