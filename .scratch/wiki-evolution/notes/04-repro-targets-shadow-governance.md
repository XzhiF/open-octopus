# P4 探路笔记 04 — 三条实证缺陷复现靶 + shadow-compare 足迹 + 治理文件现状

- 基线：main @ eca3b4ce（P3 已合入）· 笔记日期：2026-10-15 · 仓库 C:/xzf/ai/open-octopus
- 适用票：02（深回滚）/ 03（INDEX 预算）/ 04（退役清入链）/ 05（shadow 删除）/ 11（E2E 验收）+ 治理（ADR/GLOSSARY/SCHEMA）
- 知识根：`C:/Users/EDY/.octopus/knowledge`（SCHEMA.md/raw/wiki/…，git 仓在 **wiki/** 子目录）
  - 实测：`git -C C:/Users/EDY/.octopus/knowledge/wiki rev-parse --short HEAD` = `000239b`；总 commit 71；工作区净
- 本文只陈述事实（file:line 指针 + 原文摘录），不含建议。

---

## 1. 复现靶 D-kc15-3 — 深回滚窗（票 02）

### 1.1 缺陷条目全文（.scratch/knowledge-center/e2e-report.md:110-111）

> **D-kc15-3（DEFER，观察/改进建议）——回滚干净窗仅限 HEAD-adjacent。**
> 目标 compile 之后若又有 commit 触及 INDEX/LOG 共行（每编译必触），`git revert --no-commit` 三方合并冲突 → `REVERT_CONFLICT`（票12 文档化错误码，行为=契约，零副作用实证：HEAD 不动/工作区净/队列续）。产品「一键回滚本次编译」主场景成立；任意历史 commit 深回滚需改为「按目标态程序化重建 INDEX/LOG」实现（改进单）。另 revert 会撤原 compile LOG 行再 append revert 行（时间线净行数不变），审计真相面=git 史，建议文档写明。

相关行：e2e-report.md:47（LOG 语义实测钉出「git revert 会撤掉原 compile LOG 行再 append revert 行——时间线净行数不变」）、:29（执行矩阵链①：「pass2 REVERT_CONFLICT 契约分支 + paste 深环 a77fc9a→f6ae7ca→28d1621」）、:126（故事 5 行「PASS（深回滚窗=D-kc15-3）」）、:197（Conclusion 四缺陷单转后续票）。

### 1.2 现场如何构造（e2e 当时）

- pass1 浅回滚干净窗：compile `bf6928d`（2026-10-13，触 6 页）→ 紧接 revert `40bba23 revert: bf6928d — 回滚本次编译`（HEAD-adjacent，成功）→ 再编译 `e5027f7`。
- pass2 深环同型：`a77fc9a → f6ae7ca(revert) → 28d1621`。
- REVERT_CONFLICT 分支即「对更早历史 commit 发 revert」——每枚编译必共改 INDEX.md + LOG.md，历史越深共行漂移越大，三方合并必冲突。

### 1.3 失败证据（代码契约面）

- `packages/server/src/services/knowledge/wiki/revert.ts:190-202`（执行体）：
  - :196 `git revert --no-commit <target>` 非零 ⇒ :199-200 `revert --abort`（失败再 `reset --hard HEAD`）⇒ :201 抛错原文：
    `git revert 冲突（后续提交与回退互斥）：${target.slice(0, 9)} — ${revertRun.stderr 末行}`，code=`REVERT_CONFLICT`，HTTP 409。
  - 前置闸：:191-194 `WORKTREE_DIRTY`；:141-146 `NOT_FOUND`。零副作用=abort 回干净 HEAD。
  - 文件头 :25 注：「编译冲突同理（REVERT_CONFLICT，git revert --abort …）」。
- S2 契约测试钉（票02 要翻转的对象）：`packages/server/src/routes/__tests__/wiki-revert-routes.test.ts:199-214`（「后续提交与回退互斥 ⇒ 任务 failed REVERT_CONFLICT，工作区不留半成品」，:214 `expect(done.error?.code).toBe("REVERT_CONFLICT")`）。
- 端点：`POST /api/knowledge/wiki/revert {commit}` + `GET /api/knowledge/wiki/revert/task/:id`（`packages/server/src/routes/wiki-revert.ts:8-19`；mount 在 `packages/server/src/index.ts:686` `app.route("/api/knowledge/wiki", createWikiRevertRoutes…)`）。revert 经全局队列 `opKind="revert"`（revert.ts:155 `queue.enqueue("revert",…)`；kind 单源 `compile-queue.ts:34` WRITE_OP_KINDS 九类）。
- UI 消费面（错误码文案/测试，票02 连带）：`packages/web-app/hooks/use-kc-feed.ts:34`、`packages/web-app/components/knowledge-center/cards/compile-diff-card.tsx:24`、`packages/web-app/app/knowledge/__tests__/knowledge-chat.test.tsx:283`、`packages/server/src/routes/wiki-revert.ts:19`。

### 1.4 真盘现场（对靶真验材料，2026-10-15 实测仍在）

`git -C C:/Users/EDY/.octopus/knowledge/wiki log --oneline` 摘录（序号=距 HEAD 行数）：

```
 1 000239b ingest: aa16-selffix-probe2 编年体 — 触 3 页 · 新页 2 · 矛盾 1
 3 4815080 retire: sources/2026-10-14-aa16-selffix-probe.md → _retired/（superseded）
 4 705518c ingest: aa16-selffix-probe 日期时间线 — 触 3 页 · 新页 1 · 矛盾 0
 5 2e50003 ingest: karpathy llm-wiki gist — 触 8 页 · 新页 7 · 矛盾 1
 9 04cebef ingest: 素材包 task-b2d13fc1… — 触 1 页
14 0afbbcb ingest: 素材包 task-b2d13fc1… — 触 6 页 · 新页 5 · 矛盾 1
25 36d605e compile: 缺互链：… — finding 采纳修订 missing-xref · 裁决即编译（票13）
32 28d1621 ingest: kc15 rollback probe 20261013P2 — 触 3 页
33 f6ae7ca revert: a77fc9a — 回滚本次编译
34 a77fc9a ingest: kc15 rollback probe 20261013P2 — 触 3 页 · 新页 3
42 5c94d90 revert: e5027f7 — 回滚本次编译
43 e5027f7 ingest: kc15 chain1 article — 触 5 页 · 新页 5
44 40bba23 revert: bf6928d — 回滚本次编译
45 bf6928d ingest: kc15 chain1 article — 触 6 页 · 新页 6
46 492c67d compile: redistill: v2→v3（11 页）…（P2' 基线 HEAD）
```

- 实测共行度：`git rev-list --count bf6928d..HEAD -- INDEX.md LOG.md` = **44**（目标之后 44 枚 commit 触及 INDEX/LOG）。
- 可指认 commit 对（深回滚靶候选）：
  - `bf6928d8622fc072f30cf12bd67c413623066216`（第 45 行，已被 40bba23 回滚过——再 revert 因 INDEX/LOG 漂移必冲突，即原症状）；
  - `a77fc9ad7f346b4eba960ba33b46c9644facf83c`（第 34 行，同上型）；
  - 未被 revert 过的深历史靶：`a854c774bf445e8ecca2f6fa850454aea78276b7`（第 40 行 kc15 parallel note A 1791903766361）/ `62a43cb`（note B）。

### 1.5 票02 复现路径（修复前=契约失败，修复后=成功）

1. `cd` 主仓或 worktree，`pnpm build && pnpm dev`（或隔离端口，避 3000/3001/3098/3099；实例走知识根 `resolveGlobalWikiRoot()`=`C:/Users/EDY/.octopus/knowledge/wiki`，即真盘真 git）。
2. `POST /api/knowledge/wiki/revert` body `{"commit":"bf6928d"}` → 202 `{taskId:"rvt-…"}`。
3. `GET /api/knowledge/wiki/revert/task/<id>` → 现实现期望 `state:"failed", error.code:"REVERT_CONFLICT"`（票02 状态重建改造后此断言翻转为 committed）。
4. 副作用核查（零副作用契约）：`git -C C:/Users/EDY/.octopus/knowledge/wiki status --porcelain` 空、HEAD 不变、`GET /api/knowledge/wiki/queue` depth 续。
5. 票面要求现场形态（issues/02:13）：「目标编译之后又有 ≥2 次触 INDEX/LOG 的编译」——bf6928d 之后实有 44 次，天然满足。

票02 AC 全文见 `.scratch/wiki-evolution/issues/02-deep-revert-rebuild.md:11-17`（状态重建语义、REVERT_CONFLICT 废弃、deep-revert LOG 行、S1 真 git+tmpdir、:17「ADR 评估：revert=状态重建 立 ADR」）。

---

## 2. 复现靶 D-aa16-2 — INDEX 预算三连拒（票 03）

### 2.1 缺陷条目全文（.scratch/archive-assets/e2e-report.md:105-106）

> **D-aa16-2（DEFER，运营/架构）——L4 INDEX 预算闸在生产知识根已到硬顶，任何新增页的编译必败且无人工收敛路。**
> 真跑证据三连：gist 第 1/2 投、probe2 首投均败 `L4_INDEX_BUDGET: INDEX.md 约 839/854/806 token 超过预算 800 且 Optional 重排无法收敛`。当前真盘 INDEX 40+ 行（P2'+P3 沉淀自然推高），溢出 6 token 即全拒；报错建议「低频页移 ## Optional 或升 hub」——Optional 重排=自动已试不收敛，升 hub=无 UI/端点入口（INDEX 程序化重建，人工改写被写保护闸拒）。本轮以 page-retire 退役 5 个 fixture 页腾预算后第 4 投才过闸——退役是「删」非「分层」，治标。失败语义本身干净（回滚零副作用/锁释放/队续）。建议立票：INDEX 分层渲染真实生效（Active/Optional 两段制）或预算动态化+巡检容量预警。属渲染架构取舍非 quick fix 形，判 DEFER。

被 L4 拒的投喂＝**同一 gist 源的前两投（第 1/2 投）+ probe2 首投**，共三次；第 4 投 committed `2e50003`（:81）。复现步骤注①（:171）：「INDEX 若已超 800 token 预算，先 page-retire 若干 fixture 页再跑 selffix（D-aa16-2 运营前置）」。

### 2.2 源内容 gist（raw 冻结件，2026-10-15 实测在盘）

- `C:/Users/EDY/.octopus/knowledge/raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md`（12245B，Karpathy llm-wiki gist 正文；KC e2e:193 声明「失败源保留不可变（raw 层冻结契约）」）
- `C:/Users/EDY/.octopus/knowledge/raw/inbox/2026-10-14-aa16-selffix-probe2.md`（637B，编年体激将源，probe2 首投亦败 L4）
- `C:/Users/EDY/.octopus/knowledge/raw/inbox/2026-10-14-aa16-selffix-probe.md`（probe1）

### 2.3 票03「源重新投喂」的确切投喂物与端点

- 端点（`packages/server/src/routes/wiki-compile.ts:8-17` 头注 + :28）：
  - `POST /api/knowledge/wiki/compile` body `{"path":"raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md"}` ⇒ 202 `{taskId:"crt-…", rawPath, status:"queued"}`（mount：index.ts:590 `app.route("/api/knowledge/wiki", createWikiCompileRoutes…)`）
  - `GET /api/knowledge/wiki/compile/task/:id` ⇒ `{task:{state: queued→compiling→committed/failed, result|error}}`
- e2e 当时即用此投法（archive e2e:81 原文 `POST /wiki/compile {"path":"raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md"}`）。
- 事实注记（影响票03/11 复现设计）：该 gist 已于第 4 投 committed（2e50003），**现 INDEX 已回落预算内**（实测 wiki/INDEX.md 47 行/3231B，`## Optional` 节在位 INDEX.md:11「低频页 · 预算溢出自动降级」）；同 hash 重投走幂等——archive e2e:83「gist 回执页 hash 命中后重投 → committed 0s no-op」。即：按票03 AC:14「三连拒的源重新投喂→编译成功落库（预警 finding 伴随）」今天再投现实现本就成功/空转；要复现「拒」本身需先把恒见段推回 >800 token（票03 S1 用 fixture 构造，AC:16）。

### 2.4 L4 闸实现位置（改造对象）

- 预算常量：`packages/server/src/services/knowledge/wiki/lint.ts:24` `INDEX_MAX_TOKENS: 800`（WIKI_LIMITS 单源）。
- Optional 自动重排：`packages/server/src/services/knowledge/wiki/compile.ts:354-365`（renderBudgetedWikiIndex：循环把低频页移 Optional，guard<1000；:365 `overBudget: estimateTokens(content) > INDEX_MAX_TOKENS`）。
- 拒写点三处（同型报文，票03 两级化都要改）：compile.ts:487-490（compileRaw 面）、:702-704（compilePages 批量面）、:1134-1136（第三通道）。原文形状：
  `L4_INDEX_BUDGET` / `INDEX.md 约 ${tokens} token 超过预算 800 且 Optional 重排无法收敛——低频页移 ## Optional 或升 hub（拆分建议见 suggestion）`。
- 既有 L4 测试（票03 要翻转）：`wiki-lint.test.ts:274-281`（「病态巨行…Optional 化后仍 >800 → 拒写 L4_INDEX_BUDGET」）、`wiki-migrate.test.ts:362,382`（迁移面按 L4 失败计数）。

---

## 3. 复现靶 D-aa16-3 — 退役死链 + 矛盾 adopt 恒败（票 04）

### 3.1 缺陷条目全文（.scratch/archive-assets/e2e-report.md:108-109）

> **D-aa16-3（DEFER，生命周期一致性）——page-retire 不清理活页入链 ⇒ 死链潜伏，后续编译触及引用页时 L5_LINK_BROKEN 殃及；且矛盾 finding 的对手页退役后 adopt 恒 failed，唯一出路 ignore=裁决信息蒸发。**
> 真跑证据链：gist 第 3 投败 `L5_LINK_BROKEN: topics/prj-open-octopus.md 断链 [[top-dev-port-and-stale-lock]] 目标不存在`——死链来源=T1 归档编译写入 hub 页的 3 条矛盾标注行（fnd-* 引用被退役页）；`POST /findings/fnd-a6f743a4…/adopt` → 队列 task **failed「涉事页不在盘」** → ignore×3 收场。T1/T2 编译当夜 commit 成功仅因模型未复读死链——**地雷是延迟爆炸型**。建议立票：retire 执行体扩「入链摘除」第四路，或 finding-fix 对 not-on-disk 对手页降级单侧裁决。

### 3.2 死链现场（票04 原料，2026-10-15 实测原样在盘、未自愈）

被退役留死链的页（一枚，aa16 批次）：**`top-dev-port-and-stale-lock`**（原 `topics/top-dev-port-and-stale-lock.md`，retire commit `5814abd retire: topics/top-dev-port-and-stale-lock.md → _retired/（superseded）`）。

活页持链实测 `C:/Users/EDY/.octopus/knowledge/wiki/topics/prj-open-octopus.md`：

- :7 front-matter `links: [[top-workflow-node-yaml-view], [ent-node-info-dialog], [wf-prd-impl], [top-dev-port-and-stale-lock]]`（末项死链）
- :18 正文 `- dev 环境端口空转与陈旧锁的探测/自愈纪律：[[top-dev-port-and-stale-lock]]。`
- :21 「[[top-dev-port-and-stale-lock]] 记载的一手自愈路径…矛盾上报：见本次编译 findings。」
- :24/:25/:26 三条矛盾标记行（T1 归档编译写入），引用退役页：
  `> 【fnd-7695a097c4a0cd5f】与 [[top-dev-port-and-stale-lock]]（topics/top-dev-port-and-stale-lock.md）冲突：旧断言「开发这个项目启动必须是 pnpm dev --isolated…」↔ 新源断言「ECONNREFUSED 127.0.0.1:3001…」…`
  （同型 fnd-9073e3b45f3e2db8、fnd-a6f743a4a5043316——即 adopt 恒 failed 的那枚是 fnd-a6f743a4a5043316）
- 退役件在位：`C:/Users/EDY/.octopus/knowledge/wiki/_retired/topics/top-dev-port-and-stale-lock.md`（live `topics/` 下已无此文件，实测）。
- 其余同批退役（不留链者对照）：`42135c2` concepts/con-fixture-first-hand-material、`19e3837` sources/task-f6288c29…、`0b935a5` sources/task-7594fcdd…、`4815080` sources/2026-10-14-aa16-selffix-probe.md——即 e2e:77/:180 所称「dogfood 复跑 POST /wiki/retire 5 页全 committed（4 fixture 页回收 INDEX 预算 + probe1 回执页）」；wiki git log 全库 retire 行共 17 枚（12 枚 kc15 批次 77d245f…f277619 + 5 枚 aa16 批次）。

### 3.3 矛盾裁决机制与恒败点（票04 改造对象）

- 产生（编译侧）：`packages/server/src/services/knowledge/wiki/curator.ts:586-606`——findingId=`fnd-${sha256("contradiction|rawhash|old|new|claims").slice(0,16)}`（:586）；两页各 append 标记行（:590-597，禁带 raw 路径防 L5 日期闸 :587-589）；finding 行 `kind:"contradiction"`、`pages: JSON.stringify([oldWork.relPath, newWork.relPath])`（:603）、source:"compile"。SCHEMA 纪律「矛盾不静默覆盖」= `~/.octopus/knowledge/SCHEMA.md:51-52`。
- 复报（巡检侧）：`packages/server/src/services/knowledge/patrol.ts:252-281`——grep 页内 `> 【fnd-…】` 标记行恢复成 finding（`recoveryOnly:true`，detail.marker「冲突待裁决复报」:277）；`_retired/` 不参与体检（:167）⇒ 退役页上的标记不再复报、活页上的标记持续复报。
- adopt 恒败点：`packages/server/src/services/knowledge/findings.ts:221-242`——`loadWork` 用 `scanWikiEntries(wikiRoot)`（不含 _retired）查页，缺席即 :230 `throw new FindingOpsError("FINDING_TARGET_MISSING", `涉事页不在盘：${relPath}`, 409)`；contradiction/stale 共用 `semanticRevision`（:301-305 → :338-355，:348 `works = pages.map(p => loadWork(p))`）⇒ pages=[旧页,新页] 任一已退役即整单 failed，无单侧降级路径（票04 AC:14 要加）。
- 端点：`POST /api/knowledge/findings/:id/adopt` ⇒ 202 经队列 opKind="finding-fix"；`GET /findings/fix/task/:id`；`POST /findings/:id/ignore`（`packages/server/src/routes/findings.ts:11-23` 头注 + :92/:102，挂 `/api/knowledge`）。
- 退役执行体现状（票04 要扩「入链摘除」的机械）：`packages/server/src/services/knowledge/wiki/page-retire.ts:227-311`——五步=读页注 superseded → 迁 `_retired/` → INDEX 程序化重建 → LOG retire 行 → DB/FTS 摘除 → 单 commit（:307 commit 行 `retire: ${relPath} → _retired/（superseded）`）。**无活页入链摘除步骤**（实测死链即证）。路由 `POST /api/knowledge/wiki/retire`（`routes/wiki-retire.ts:31`，头注 :5-22；opKind `page-retire`=compile-queue.ts:34）。
- 死链检测形状（复验断言用）：`lint.ts:210-218`（body `[[...]]` 逐个 `resolveWikiLink(target, root, linkCorpus)`，缺席集 ⇒ :217 `{level:"L5",severity:"error",code:"L5_LINK_BROKEN",message:"断链 [[...]] 目标不存在: [[x]], …"}`）；front-matter links 同闸（wiki-page-v3.test.ts:276-279「front-matter links and body [[...]] both gate」）；批量面 lint.ts:436 同型；cases 页断链不豁免（wiki-cases.test.ts:189-191）。

票04 AC 全文：`.scratch/wiki-evolution/issues/04-retire-link-cleanup.md:11-16`。票11 相关：链⑤自动退役+INDEX 预算复现靶（issues/11:16-17）。

---

## 4. shadow-compare 足迹（票 05 删除对象全清单）

全仓 grep（`shadow|ShadowCompare|SHADOW_|__relevant_rule_ids|__injected_rule_ids|buildShadowComparison|injectSide`；web-app 的 shadow 命中实测全部为 CSS `box-shadow`，与本片无关）。

### 4.1 代码面（删除/收口对象）

| # | 位置 | 内容 |
|---|------|------|
| 1 | `packages/server/src/services/knowledge/shadow-compare.ts`（整文件 150 行） | 服务本体。头注 :1-19=「冻结只读…边界注定稿（票08·spec 故事33）：保留=有意为之的历史审计面…删除留 P4 后议…清理前勿新增消费者」；`SHADOW_RELEVANT_KEY="__relevant_rule_ids"` :25、`SHADOW_INJECTED_KEY="__injected_rule_ids"` :26、`SHADOW_QUERY_KEY=WIKI_REFS_KEY` :28；`ShadowComparison` 接口 :30-58（injectSide/querySide/quadrants 四象限/metrics）；纯函数 `buildShadowComparison` :107-149 |
| 2 | `packages/server/src/routes/execution.ts:15` | `import { buildShadowComparison } from "../services/knowledge/shadow-compare"`（唯一授权消费点） |
| 3 | `packages/server/src/routes/execution.ts:275-300` | 端点路由：注释块 :275-283（含「__relevant_rule_ids/__injected_rule_ids，既有 VarPool 键，只读」「冻结只读…勿新增消费者」）+ :284 `executionRoutes.get("/:executionId/shadow-compare", …)` → :299 `c.json(buildShadowComparison(executionId, pool))`。mount=index.ts:489 → 全路径 `GET /api/workspaces/:id/executions/:executionId/shadow-compare` |
| 4 | `packages/server/src/services/knowledge/__tests__/shadow-compare.test.ts`（整文件） | 四象限 fixture 冻结 :34-118；键名单源断言 :116-118；**「零新增消费者」负断言** :122-172（ALLOWED_BASENAMES={"shadow-compare.ts","execution.ts"} :128，全 src grep 面）——票05 删除时此测试群整体到尸 |
| 5 | `packages/server/src/__tests__/shadow-compare-route.test.ts`（整文件） | S2 路由测试；:66 请求行 `/api/workspaces/${WS}/executions/${executionId}/shadow-compare`；:109-130 新执行 injectSide 恒空 + 历史行仍可读断言 |
| 6 | `packages/shared/src/types/knowledge.ts:37-38` | 边界注释「…以下两常量仍被 vars_update→VarPool 查阅信道与 shadow-compare 消费」——`WIKI_REFS_KEY`(:42)/`STALE_REF_PREFIX`(:45) 本体**存活信道在用，不删**；票05 只需修注释措辞。**注：SHADOW_* 常量不在 shared**（单源在 server shadow-compare.ts:25-28；票面措辞「shared 类型/SHADOW_* 常量（单源）」按此实况执行） |
| 7 | `packages/engine/src/__tests__/wiki-refs-persistence.test.ts:9,13,36,79` | :9/:13 注释指认 server shadow 测试为读回方；:36 fixture `REFS_LINE` 含 `"shadow_summary":"refs-landed"` 键、:79 断言之——删除联动点 |
| 8 | `packages/engine/src/__tests__/injection-removal.test.ts:128-130` | VarPool 影子键负断言（poolSnapshot 不含 `__relevant_rule_ids/__user_preference_text/__injected_rule_ids`）——生产端已删的回归钉，票05 面「读取面收口」时此负断言属保留资产（负断言不指向被删模块） |
| 9 | `packages/server/src/services/knowledge/__tests__/file-ops.test.ts:127` | 注释（`__user_preference_text` 生产件随注入链退役） |
| 10 | web-app 全仓 | **零 shadow-compare 引用**（实测 grep -rln 无命中）——删除无前端连带 |

### 4.2 文档/证据面（加注对象，票05 AC:13「追加注记不改写原文」）

- `GLOSSARY-MAP.md:35` — 「影子期 (Shadow Mode)」废弃词条行：含端点全路径、两注入键名、四象限语义、「shadow-compare 端点冻结只读为 p2-gate-pass 证据链审计面，读面清理划入后续处理」。
- `docs/adr/0030-…:20` — 「shadow-compare 端点冻结只读（P2 证据链，删表属后续清理）」。
- **p2-gate-pass.md 位置：`.scratch/llm-wiki-loop/p2-gate-pass.md`**（在，56 行）。「§2 证据指针」内容=§2「真实数据盘点（指针均指 e2e-report.md）」（:14-28）：14 条真 provider 执行行带 wiki_refs（:20）、对照导出 Evidence 4 原 JSON `hit=[]/miss=15/queryOnly=2`（:28，指 `.scratch/llm-wiki-loop/e2e-report.md:93` 起「Evidence 4 — 影子对照导出真实行」，:95 有完整 GET 原行）；:12「每条带 shadow-compare 四象限导出」。§3 诚实局限（hit 恒空是 id 体系失配的结构性）:28-34。
- `.scratch/knowledge-center/e2e-report.md` 引用 shadow 的行号：**78**（链④零注入：var_pool 键集 + `shadow-compare 原行 "injectSide":{"relevant":[],"injected":[]}`（引 spec 行104 冻结空））、**169**（R3 交叉验证「链④ JSONL↔var_pool↔shadow」）。票05 要加注的两处证据引用即此两行 + p2-gate-pass §2。
- `.scratch/archive-assets/e2e-report.md:79`（「shadow-compare 头注定稿措辞在读 + 端点保留（故事 33）」）、`:149`（故事 33 行 PASS（静+读面））。
- 历史归档（非代码，留档不改写）：`.scratch/knowledge-center/spec.md:104`（冻结只读裁决原文）、issues/08:14,25,36、issues/09:24、issues/01:22；`.scratch/llm-wiki-loop/issues/12-shadow-mode-refs.md`（影子期原票 Status:done，Comments 记 Landed 端点与 GLOSSARY 入册）、`.scratch/llm-wiki-loop/e2e-report.md:93-204` 多行、spec.md/manual-acceptance.md；`.scratch/wiki-evolution/spec.md`+issues/05（删除计划本体）。
- `.claude/sessions/5a166ae3-…/workflows/runs/wf_c8bef9b9-f33/snapshot.json` 及同名 scripts — 会话瞬态（非仓库交付物）。
- 删除边界前案（票05 Reference，issues/05:7）：commit `ab36d987`「shadow-compare 服务头与 execution.ts 端点注补 pending_review 式边界注：保留=有意历史审计面，读面清理划入后续处理，清理前勿新增消费者」。

### 4.3 VarPool 影子键「文档注记」其余位

- `docs/research/knowledge-system/03-knowledge-injection.md:12,61`、`docs/research/knowledge-system/08-data-flow.md:553,557` — 旧注入链研究存档中的 `__relevant_rule_ids` 读写描述（历史 research 文档；票05「文档注记清理」射程内可加注/标注废弃，非代码）。

---

## 5. 治理文件现状

### 5.1 docs/adr/

- 目录实测：现存 `0001`、`0005`–`0031` 连续（**0002-0004 历史缺号**）；最新= `0030-karpathy-3layer-compiled-wiki-abolish-approval.md`、`0031-wiki-global-write-serialization.md`。**下一可用编号=0032**（票02「revert=状态重建」ADR）。
- 格式模板（0029/0030/0031 实测同构）：
  ```
  # ADR-00NN: <一行标题（中文，破折号副题）>
  (空行)
  Date: YYYY-MM-DD
  Status: Accepted
  Related: <关联 ADR/spec/票/文书，amends 写法见下>
  ## Context
  ## Decision          ← 编号条目或加粗总句+编号细分
  ## Considered Options ← 「X — 被否（理由/裁决人）」逐条
  ## Consequences      ← 按包/面分点（server/engine/web-app/词表同步/风险）
  ```
- **amends 写法**（ADR-0030:5 原文样）：`Related: **amends ADR-0029**（三分离段的 wiki 定位：「org 词条」→ 全局唯一三层库；…）；**收编「写入单一闸门」前案**（…当年未落 docs/adr，属治理欠账，本篇点名修正…）；承 P2 过闸文书 .scratch/llm-wiki-loop/p2-gate-pass.md（…）`。即：amends 用粗体 `**amends ADR-XXXX**（被改范围括注）` 落在 Related 行，不另设段落。
- 立册惯例（commit b1764089 先例=ADR 与 GLOSSARY-MAP 修订同 commit）：新增 ADR 后在 `GLOSSARY.MAP` 底部 `## System-wide ADRs` 列表挂一行 `- [NNNN-文件名.md](docs/adr/NNNN-文件名.md) — 一行 gist`；0030/0031 挂行=GLOSSARY-MAP.md:198/:199。该列表自带注（:201）：「本索引非穷举——0021～0029 未列，补齐留治理整理票；新增 ADR 请顺手在此挂行」。
- ADR-0031 与票02 直接相关：Decision 1 把「回滚 revert」列为 WRITE_OP_KINDS 共队七类之一、Consequences 记 revert 写通道入队（`compile-queue.ts:24,34` 现九类：ingest-compile/archive-compile/dialog-revise/lint-fix/finding-fix/revert/redistill/case-archive/page-retire）。票02 语义换芯（git revert→状态重建）不改闸，正合 ADR-0031 的「唯一写闸外层」定位；新 ADR 需 amend/衔接 ADR-0030 Decision 5「git 一次编译一 commit + UI 一键回滚」。

### 5.2 GLOSSARY-MAP.md

- 位置=仓库根 `C:/xzf/ai/open-octopus/GLOSSARY-MAP.md`（201 行）。结构：`# Context Map` → `## System-wide Glossary`（词条表 Term|Definition|Primary Package，含 :35 影子期废弃行、:137 策展人、:138 raw 层、:139 SCHEMA.md、:140 编译队列、:144 审核队列废弃行等知识域词条）→ Anti-patterns 表 → `## Package Contexts`（:159-167 各包 GLOSSARY.md 路径表）→ **缺失注记 :169-170**：「注（知识中心 code-review S4 登记）：上表所列**各包 GLOSSARY.md 尚未建立**（预存治理欠账，非本 phase 引入）；补齐前包级词条一律以本 map 为准，勿在包内另立词表。」→ `## Cross-Package Relationships`（:173-183）→ `## System-wide ADRs`（:185-201）。

### 5.3 SCHEMA.md（知识根 `C:/Users/EDY/.octopus/knowledge/SCHEMA.md`，5298B/73 行，2026-10-13 23:03 落盘）

- 章节标题实测序列：
  1. `# SCHEMA.md — wiki 共演约定（层 3 · 人工确认制）` + 引言 blockquote（策展人编译前必读；策展人只能提议，落笔永远由人；自动通道永不改写本文件与 user_preference.md）
  2. `## 三层契约`（raw 不可变/wiki 唯一写闸/SCHEMA 本文档）
  3. `## 页格式约定（v3 五类页）`（五类目录表 entities/concepts/topics/sources/cases + 正文纪律段）
  4. `## 命名法`（页 id 前缀 ent-/con-/top-/src-/case-；锚点 `<!--#oct-NNN-->` 只在 topic「硬约束」、全库唯一永不复用、发号=全库 max+1；INDEX 分组 必读/Entities/Concepts/Topics/Sources/Cases/Optional + 预算 ≤800 token；LOG 行格式 `## [date] ingest|compile|query|lint|revert | title`）
  5. `## 编译纪律（唯一写闸 — 写入单一闸门）` 六条编号（唯一写入口/一次编译=一个 git commit/矛盾不静默覆盖/溯源闭环/pre-commit 写权闸/幂等）
  6. `## 工作流（审批废除后的质控六道）`（投喂即编译/先看后纠/裁决即编译）
  7. `## 指针`（octo-wiki-curate / octo-wiki 两 skill）
- 「判据」现有写法样例（原文摘录）：
  - 断链判据：「`links` 为 [[wikilink]] 目标数组，编译期断链校验（**目标不存在 ⇒ 拒写**）」（:18-19）
  - 容量判据：「单页容量闸 ≤120 行 / ~2000 token，**超限拆分**（对话内自纠，拆分建议随编译失败返回）」（:31）
  - 预算判据：「程序化重建，**永不经 LLM/人手写**，预算 ≤800 token（低频页溢出移 ## Optional）」（:40-41）
  - 日期判据：「**常青正文零日期**（日期由 front-matter sources / LOG.md / git history 三处承接；sources 页为编译回执，允许…）」（:29-30）
- 「权重」现状：**SCHEMA.md 内无任何数值权重体系**；最接近字段=cases 行「symptom/tags/severity/occurrences/rule_ref」（:27）与 front-matter 保留字段 `stability/confidence`（:18）。confidence 滚动/数值处方属 P4 预留面（`.scratch/archive-assets/spec.md:137`「P4 残余：effectiveness v2…confidence 滚动、doctor 数值处方…」；表 `knowledge_effectiveness` 边界注见 ADR-0030 Consequences :31）。票02/03/04 若要改判据（如 L4 两级、入链摘除、deep-revert LOG 行格式），落笔是人——SCHEMA.md 受 MANUAL_FILE_WRITE 主闸写保护（GLOSSARY-MAP:139；`ensureSchemaDoc` 仅缺席 seed，curator.ts:348）。

---

## 6. 汇总指针速查（implementer 直达）

- 深回滚：revert.ts:190-202（冲突抛出+abort 零副作用）/ wiki-revert-routes.test.ts:199-214（翻转对象）/ 真靶 commit `bf6928d`（44 枚后续 INDEX/LOG 共行）/ 队列 kind "revert"（compile-queue.ts:34）。
- INDEX 预算：lint.ts:24（800 单源）/ compile.ts:354-365（Optional 重排）+ :487/:702/:1134（三拒写点）/ 真源件 raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md / 投喂端点 POST /api/knowledge/wiki/compile。
- 退役死链：page-retire.ts:227-311（执行体缺入链摘除）/ findings.ts:230（FINDING_TARGET_MISSING「涉事页不在盘」）+ :348（semanticRevision pages 全载）/ curator.ts:586-606 + patrol.ts:252-281（矛盾产生/复报）/ lint.ts:210-218（L5_LINK_BROKEN 形状）/ 真现场 topics/prj-open-octopus.md:7,18,21,24-26 + _retired/topics/top-dev-port-and-stale-lock.md / 5×retire commits `0b935a5 19e3837 42135c2 5814abd 4815080`。
- shadow 删除：清单 §4（server 4 文件 + shared 注释 1 + engine 测试 2 + 文档加注 GLOSSARY-MAP:35 / ADR-0030:20 / p2-gate-pass §2 / KC e2e:78,169 / aa e2e:79,149）。
- 治理：ADR 下一编号 0032；模板与 amends 写法=§5.1；GLOSSARY-MAP 包级缺失注 :169-170；SCHEMA 判据样例=§5.3。
