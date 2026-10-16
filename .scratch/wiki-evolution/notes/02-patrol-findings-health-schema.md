# E2 勘探笔记 — patrol/findings 插座 · knowledge_effectiveness · 健康条 · SCHEMA.md · LLM seam · 执行 JSONL

- 基线：main @ eca3b4ce（P3 已合入）· 日期 2026-10-15 · 只读勘探，零改仓库
- 适用票：`.scratch/wiki-evolution/issues/` 票 06/07/08/09/11（P4 wiki 进化闭环）
- **编号提醒**：下文引用的代码注释里「票NN」均为 P2 knowledge-center / P3 archive-assets 项目的票号（如巡检=KC票13、健康条=KC票11），与本 P4 票号是两个体系。
- 本文件为进程重启后按已探上下文重写版（原 C:/tmp 落盘不可靠，弃用）。

---

## 1. patrol 巡检服务（票08 扩查对象）

**服务文件** `packages/server/src/services/knowledge/patrol.ts`
- `class WikiPatrolService` :109-489；入口 `patrol(): PatrolReport` :122-161
- `PatrolDeps` :80-85（db / root? 测试注入 tmpdir / now? 时钟注入——90 天/到期判据可钉表）
- **`PatrolFindingKind` 枚举单源** :43 = `"contradiction" | "stale" | "orphan" | "missing-page" | "missing-xref" | "case-backlog"`（现六值）
- `PatrolAction` :46 = created|refreshed|unchanged|suppressed；`PatrolFindingEntry` :48-58（id/kind/title/pages/action/[target]/[hosts]）；`PatrolReport` :71-78（scanned{pages,executions}/findings/counts/newFindings/warnings）
- finding id 内容寻址：`sha16` :89-91 = `fnd-` + sha256(key) 前 16 hex ⇒ **同证据同 id、幂等根基**（六查注释 :19-20：全部确定性遍历、不经 LLM）

**语义六查（方法名与产出形状）**
| 查 | 方法 | 行 | 判据/产出 |
|---|---|---|---|
| ① contradiction | `contradictionDrafts` | :248-284 | 扫盘上「## 冲突待裁决」标记行 `>【fnd-…】` :252；detail={old_claim,new_claim,pages,marker}；**recoveryOnly** :276（行已存在绝不改写——复报面，与编译通道天然同址零双报） |
| ② stale | `staleDrafts` | :293-354 | DB `executions.var_pool` LIKE `%"wiki_refs"%` :300-302，取 `stale:<ref> <note>` 行（`STALE_REF_PREFIX` 单源 shared/src/types/knowledge.ts:45；ref 三形态 `页id#锚`/裸 `oct-NNN`/页路径，归属 :287-291）；窄口注释 :289-291（正常查阅不产 finding） |
| ③ orphan | `orphanDrafts` | :383-417 | 内容页（CONTENT_TYPES :87 = entity/concept/topic/case）零入链；sources 回执页不算入链方 :27-28；**case.rule_ref 指针边豁免** :393-401（防蒸馏产物必产孤儿假阳性） |
| ④ missing-page | `missingPageDrafts` | :461-488 | [[链接]]/front-matter links 目标经 `resolveWikiLink`（wiki/lint.ts:120，与编译期 L5 断链闸同一判据单源）解析失败；带 target/hosts |
| ⑤ missing-xref | `missingXrefDrafts` | :423-458 | 同 type（entity/concept/topic）共享 ≥1 topic 标签且互不链接 ⇒ 建议对；case 不参与 :420-422 |
| ⑥ case-backlog | `caseBacklogDrafts` | :223-240 | 判例 front-matter：status=open ∧ occurrences≥2 ∧ rule_ref undefined（P3 票03，spec 故事13） |

- **汇总/扩展钩子点**：`collectDrafts` :205-214 —— 六查数组；加第 N 查 = 新 `*Drafts` 方法 + 此数组加一项（票08 数值五查 D1-D5/D7 即此钩子）。
- 裁决三态纪律（主循环）:131-145：既有行 status ∈ {resolved, ignored} ⇒ `suppressed` **永不再扰**；open 且 `sameEvidence`（:492-494，title/detail/pages/raw_ref 四字段）⇒ `unchanged` 零写；否则 upsert 刷新。幂等注释 :36-38。
- 副作用面 :40-41：**只写 findings 表**，wiki/fs/git 零触碰（夜巡不起写队列）；读永不锁。
- 页视图加载 `loadPages` :164-192：真 fs（scanWikiEntries+parseWikiFile），`_retired/` 不参与体检 :167，坏页跳过留 warning :171-173。
- DB 计数面 `countExecutions` :194-203（裸库诚实零）。

**finding 落库**
- 表：`packages/server/src/db/schema.sql:1097-1111`——findings(id PK, kind TEXT **无 CHECK**（值面开放，:12-13 DAO 头注「避免加值要动表」）, status TEXT CHECK IN ('open','resolved','ignored') :1100, title, detail JSON, pages JSON, raw_ref, source('compile'|'patrol'), created_at, updated_at)；索引 idx_findings_status / idx_findings_kind_status :1110-1111。
- DAO：`packages/server/src/db/dao/findings-dao.ts`——`FindingStatus` :16；`FindingRow` :18-33；`FindingUpsert` :35-43；`upsert` :51-59（ON CONFLICT 刷证据、**status 永不覆盖**=不回滚人裁决）；`getById` :61；`list(status?)` :66（created_at DESC）；`countOpen` :73（健康条开放 findings 单源）；`updateStatus` :79（裁决迁移，CHECK 钉三态）。

**findings API（挂 `/api/knowledge`）** `packages/server/src/routes/findings.ts`
- 契约总述注释 :10-25。形状：
  - `GET /findings?status=open|resolved|ignored` :80-90 → `{org, findings[]}`（camelCase 视图 `findingView` :44-57，detail/pages 解 JSON、坏形诚实回空形 :59-65）
  - `POST /findings/:id/adopt` :92-100 → **202** `{findingId, taskId, status:"queued"}`；404 NOT_FOUND / 409 FINDING_ALREADY_ADJUDICATED
  - `POST /findings/:id/ignore` :102-110 → 200 `{findingId, status:"ignored"}`（同步、零编译）
  - `GET /findings/fix/task/:id` :112-116（进程内 registry，重启即清——404 文案明示 git LOG 为审计真相）
  - `POST /patrol` :118-124 → PatrolReport（手动「体检一下」即时通道）
  - `POST /backfill` :126-142 → 202（对话摘录→raw 冻结→编译投递）
  - [讨论] **无端点**（零状态变更，:23-24）；错误面 `{error:{code,message}}` 稳定码。
- 装配（组合根）：`packages/server/src/index.ts:711-726`（ops 五方法转发 getFindingOps；`patrolNow` :719-724 = patrol() + P3 票04 b 路 `getSkillDrafts().detectProceduralCases()` 同钩子语义）。

**「裁决即编译」通道（adopt→经队列编译）** `packages/server/src/services/knowledge/findings.ts`
- `class FindingOpsService` :89；`adopt` :130-151 —— 校验 open（`requireOpen` :171-178）→ 建 FixTaskRecord（id 形如 `fft-<yyyymmddHH>-NNN` :132）→ `this.queue.enqueue("finding-fix", …, {taskId, label:"kind:id"})` :142-149。**生产 queue = 全局 CompileQueue 单例** `wikiWriteQueue`（index.ts:557-559，带 `WikiLock` 跨进程锁文件；注入 index.ts:578-586）。
- opKind 单源：`packages/server/src/services/knowledge/wiki/compile-queue.ts:25-35` `WRITE_OP_KINDS` = ingest-compile / archive-compile / dialog-revise / lint-fix / finding-fix / revert / redistill / case-archive / page-retire（现九类；`depth()` :73 = 健康条 queueDepth 口径）。**票07 effectiveness-sync、票09 auto-retire 新 opKind 入此枚举**（spec L78/L90 点名）。
- **handler 分发点 = `execute()` 按 kind 的 switch** :221-335：
  - `missing-xref` :246-256（两页互加 links，确定性）
  - `orphan` :257-273（同 topic 字典序首位宿主补链 + `## 相关` 追加 :602-609；无可挂链 ⇒ FINDING_FIX_NO_RELATED 响亮失败 :265-266）
  - `missing-page` :274-300（stub 建档，`pageIdForTarget` :589-599 CJK 走哈希址）
  - `contradiction` / `stale` :301-305 → `semanticRevision` :338-417（**LLM seam**，见 §6；锚点守门 FINDING_ANCHOR_LOST :402-407；服务端剥本 finding 标记行 `stripFindingMarkers` :572-586）
  - `case-backlog` :307-312 → `distillCase` :431-510（确定性蒸馏 + procedural 打标 `judgeProcedural` :519-528）
  - default ⇒ `FINDING_FIX_UNSUPPORTED_KIND` :313-314。**新增 kind 的出口钩子 = 此 switch 加 case**
- 落盘：`WikiCompileService.compilePages` :318-328（唯一写闸 + lint 闸照过）；成功 ⇒ `start()` :180-218 `updateStatus resolved` + Lane A 回执（compile-diff 卡 + finding 终态卡 :192-208；生产 reportReceipt = index.ts:583-585 `appendKnowledgeSessionCards`）。
- **ignore 语义**：`ignore` :123-127 同步迁移 ignored 持久记录在案；patrol 侧 suppressed 永不再扰（:138-139）；DAO upsert 契约不回滚裁决（findings-dao.ts:8-13 头注）。
- 卡协议兼容面：`packages/shared/src/knowledge-center/card-protocol.ts:341-347` `KcFindingCardData.kind: string`——注释明示「…开放」:344-345 ⇒ **PatrolFindingKind 扩值零改卡类型**（票08「零新卡类」成立）。卡投影 `findingCardData` services/knowledge/patrol-job.ts:34-60。

---

## 2. 夜巡 scheduler 挂载

- **系统作业表单源**：`packages/server/src/services/scheduler/builtin-jobs.ts`（ADR-0021 `job` 型内置作业）
  - `KNOWLEDGE_PATROL_HANDLER = "knowledge-patrol"` :23
  - `BUILTIN_CODE_JOBS` :40-65 —— 现有 **2 个步骤/行**：`builtin-task-lifecycle`（cron `* * * * *` :48）与 `builtin-knowledge-patrol`（cron **`17 3 * * *`** Asia/Shanghai、timeout 600、enabled 1 :55-64；描述 :58 明示「停用只停自动体检，手动『体检一下』不受影响」）
  - 确定性行 id `builtinJobId` :73-75；`seedBuiltinCodeJobs` :99-155（create-if-missing；conflict 只修 job_type/config、**保留用户的 enabled/cron 调参**；软删行修复复活 :132-141）
  - **扩步骤注册法（现状形态）**：夜巡是**单 handler**，步骤链在 handler 内：`knowledgePatrolHandlerFor` services/knowledge/patrol-job.ts:133-166 —— ① `patrol()`（六查）② `opts.report` 报对话（只报 created，幂等不刷流 :25-26）③ `opts.afterPatrol` 产出后钩子（:120-130，P3 票04 b 路即此钩子——**失败显形进 outcome 不炸作业** :147-154）。票06/08/09 的「既有作业扩步骤（不新建作业）」= 在此 opts 链/collectDrafts 上挂新腿；若真要新建系统作业：BUILTIN_CODE_JOBS 加行 + `registerAndSeedBuiltinCodeJobs` :212-223 rebind（未注入走响亮占位 `unboundKnowledgePatrolHandler` :189-194）。
- **组合根注入点**：`packages/server/src/index.ts:1110-1122`（`getFlag('scheduler')` 闸 :1089 内）——`knowledgePatrolHandlerFor(getKnowledgePatrol(), { report: createKnowledgeSessionReporter(getDb()), afterPatrol: () => getSkillDrafts().detectProceduralCases() })`；scheduler 域不 import 知识域（注入纪律注释 :1106-1110）；引擎 `SchedulerEngine.start()` :1129-1142；行级手动触发 = `onTrigger → schedulerEngine.triggerManual` :1137-1140（运维页/scheduler API）。
- 报对话载体：`createKnowledgeSessionReporter` patrol-job.ts:101-118 + `appendKnowledgeSessionCards` :73-97（会话判据：archive 分身 ∧ title=知识中心 ∨ scope_id=knowledge；无会话诚实降级 :83-85）。
- 测试先例：`services/knowledge/__tests__/patrol-job.test.ts`（handler 直调、不起 HTTP 不起泵 :74/:104）、`skill-draft-patrol.test.ts`（afterPatrol 语义 + boom 不炸 :48）、`services/scheduler/__tests__/builtin-jobs.test.ts`、`code-job-executor.test.ts`。

---

## 3. knowledge_effectiveness 表

- **定义与边界注**：`packages/server/src/db/schema.sql:1034-1048`。表边界注全文（:1034-1038）：
  > knowledge_effectiveness 边界注（code-review S1 / 2026-10-24 评审修复）：注入链生产者已随知识中心票08 物理删除，服务层死链（effectiveness.ts/maintenance.ts/generate.ts 及其自测）已按 CODING_STANDARDS #5 清除；**表本体与 DAO 保留**——spec Out of Scope 点名 P4 残余「effectiveness v2（JSONL 解析 ↔ blocker 关联、confidence 滚动更新）」的预留面，勿删本表；重启消费面前须连同滚动更新语义整体设计（勿复活旧关键词匹配近似）。
- 列面（:1039-1046）：`rule_id TEXT PRIMARY KEY` / `injected_count INTEGER NOT NULL DEFAULT 0` / `helpful_count DEFAULT 0` / `not_helpful_count DEFAULT 0` / `last_injected TEXT DEFAULT NULL` / `confidence REAL NOT NULL DEFAULT 0.5`；索引 `idx_effectiveness_stale(injected_count, confidence, last_injected)` :1048。
- **DAO** `packages/server/src/db/dao/knowledge-effectiveness-dao.ts`：类注 :13-18（「业务层现**零 importer**…与表同进退，勿单独复活旧语义」）；Row :4-11；`upsert` :24-41（COALESCE 增量）；`getByRuleId` :43；`listAll` :47（last_injected DESC）；`listStale(minInjected, maxConfidence, daysSinceLastInjected)` :51-59（days=0 跳日期检查）；`incrementInjected` :61-69；`incrementHelpful` :71-78（confidence=ROUND((helpful+1)/injected,3)）；`incrementNotHelpful` :80-87（confidence=ROUND(helpful/injected,3)）。
- 列语义现vs P4 v2 口径（票06 AC1 迁移面）：injected_count 旧=注入计数 → v2=**引用计数**（更名或加列，蓝绿）；last_injected → **最近被引用时间**（票08 D3 僵尸 90 天 / 票09 窄口 last_cited 判据原料）；helpful/not_helpful → blocker 关联判定落账（票06）；confidence 编译期静态初值 → 滚动 helpful/(helpful+not_helpful)（票07，DB 真源、页 front-matter 为快照）。
- **现有读写方**：服务层零 importer；仅装配位——`db/dao/index.ts:20-21`（导出注：与表边界注同律勿删）、server `index.ts:180/:204/:440`（daos.knowledgeEffectiveness 容器位，惰性）；类型面 `packages/shared/src/types/knowledge.ts:9-16` `KnowledgeEffectivenessSchema` 保留（:7 注「P4 预留面」）；自测 `db/dao/__tests__/knowledge-effectiveness-dao.test.ts`、`server/src/__tests__/db-schema.test.ts`。
- **git 史旧 effectiveness.ts**：`git log --all --diff-filter=D -- "**/effectiveness.ts"` ⇒ **cc6b2d4b**（refactor(knowledge): 死链收口——评审S1/CODING_STANDARDS #5，删 effectiveness/maintenance/generate 三服务及自测；提交头注点名「表+DAO=P4 预留面，JSONL↔blocker 关联、confidence 滚动更新正对表列，故不删而补 pending_review 式边界注」）。被删文件头注（`git show cc6b2d4b~1:packages/server/src/services/knowledge/effectiveness.ts`）：P4.1「zero LLM cost — pure keyword matching」。三行教训：
  1. **词面撞车当因果**：规则文本 >3 字符关键词与失败文本（失败节点 lastOutput + `poolSnapshot.review_blockers`）重叠率 ≥30% 即判 not_helpful——规则越切题越易被记「无用」，把相关性罚成罪性。
  2. **近似无判据地基**：阈值（词长>3/30%）纯拍脑袋，账目撑不起 confidence 语义，故边界注一刀封死「勿复活旧关键词匹配近似」——票06 关联判定**必须走 LLM seam**（schema.sql:1038 + 票06 Reference 行双钉）。
  3. **上游寄生运行时即蒸发**：trackEffectiveness 吃 `poolSnapshot.__injected_rule_ids`（生产者 KnowledgeInjector 随 KC票08 物理删除），记账面整条挂空——票06 因此定形「服务端离线解析执行产物、agent 运行时零感知」（票06 负断言 AC）。

---

## 4. 健康条

**后端数据面**
- `GET /api/knowledge/health`：`packages/server/src/routes/knowledge-read.ts:164-201` —— 形状 `{org, pages:{total,entity,concept,topic,source,case}, rawSources, ingestedThisWeek, openFindings, queueDepth, lastCompiled, gitHead}`：
  - 分页桶 :169-175（DB domain 列混存 v2/v3，映射单源 `WIKI_DOMAIN_TO_PAGE_TYPE` :86-89，shared/src/types/wiki.ts:64）；本周口径 ISO 周周一起 :76-80；`gitHead` 只读降级诚实 null :181-186。
  - 注入位 opts `getQueueDepth?/getOpenFindings?` :39-42（缺省稳定零值——**「契约形状先定，后续票只换值不换形」** :20-22/:162-163；生产接法 index.ts:705-708 = `wikiWriteQueue.depth()` + `getFindingOps().countOpen()`）。票08 health score 按此先例加字段。
  - **响应不存在「待审核」字段**（审批概念废除，spec D6）:21-22。
- wiki tree stats：`packages/server/src/routes/wiki.ts:157-204` —— `stats:{entries,cases,rules,lastCompiled}` :163-168；entries 每项带 `stability` 与 `ruleCount`（`extractRuleAnchors(r.body)` :189-192——票08 膨胀榜/域失衡的现成计数源）；pendingReview 已随废除摘除，负断言指针 :197-198。
- queueDepth 口径单源：`wiki/compile-queue.ts:73` depth()=queued+running（routes/wiki-queue.ts:8 同口径注）。

**Web 组件面**
- 渲染位：`packages/web-app/components/knowledge-center/health-bar.tsx` —— `HealthBar` :12；testid `kc-health-bar` :28 / `kc-health-error` :15；现有指标项 :31-46（页数按类/raw 源/本周 ingest/**findings（openFindings>0 琥珀色 :40-42）**/队列/最近编译/HEAD）；**失败显形不伪造零值** :9-10（CODING_STANDARDS #2）；票08 score 落点 = 此条加槽 +「点开出 ranked findings」复用 findings 列表通道（GET /findings，无新页面）。
- 类型：`packages/web-app/lib/knowledge/knowledge-center-api.ts:119-128` `KcHealth` + `getKcHealth` :152-155；宿主 `app/knowledge/page.tsx` :47/:85/:163；刷新回调钩子群 `hooks/use-kc-findings.ts:24/:36`、`use-kc-feed.ts:47`、`use-kc-packs.ts:19`、`use-kc-cases.ts:20`（「宿主刷新 health/tree」）。
- 分桶显示镜像注：`components/knowledge-center/knowledge-tree.tsx:11`（客户端不引运行时值）。

**S4 测试先例（含「健康条口径负断言先例」）**
- server：`packages/server/src/routes/__tests__/knowledge-read-routes.test.ts:150`（「票面口径七项，无『待审核』」）+ **:213-216 契约负断言**（`expect(text).not.toContain("待审核")`——票08/07 新增字段时的钉法母版）。
- web：`packages/web-app/app/knowledge/__tests__/knowledge-center.test.tsx:146-186` —— 七项口径渲染 :149；**负断言全页无「待审核」** :165-169；取数失败 ⇒ error 条显形且 `kc-health-bar` 不渲染 :181-186。
- tree 面负断言：`routes/__tests__/wiki-routes.test.ts`（指针见 wiki.ts:198 注）。

---

## 5. SCHEMA.md（~/.octopus/knowledge/SCHEMA.md）

- 真文件 72 行。章节结构（现状）：
  1. 标题 + 引言 blockquote :1-6 ——「层 3 · 人工确认制」；策展人只能**提议**、落笔永远由人；**自动通道永不改写本文件与 user_preference.md**。
  2. `## 三层契约` :7-13 —— raw（层1 不可变）/ wiki（层2 唯一写闸）/ SCHEMA（层3）。
  3. `## 页格式约定（v3 五类页）` :15-31 —— **表格**列五类页收载与格式；正文纪律段（常青零日期 / 禁 >20 行长代码块 / **容量闸 ≤120 行 ~2000 token**，:29-31）。
  4. `## 命名法` :33-43 —— 页 id 前缀、raw 路径形、**规则锚点 `<!--#oct-NNN-->` 只存 topic「硬约束」、全库唯一永不复用、发号 max+1**（:37-39，票09「原号随迁」要与之对表）、**INDEX ≤800 token 低频溢出 ## Optional**（:40-41，票03/08 两级预算改造对象）、LOG 行格式 :42-43。
  5. `## 编译纪律（唯一写闸）` :45-57 —— **编号六条**（唯一写入口 / 一次编译=一个 commit / 矛盾不静默覆盖 / 溯源闭环 / pre-commit 写权闸 / 幂等）。
  6. `## 工作流（审批废除后的质控六道）` :59-67 —— 要点式：投喂即编译 / 先看后纠（点名「语义巡检产 findings 报对话」）/ **裁决即编译**（:67 枚举现为「矛盾/stale/孤儿/缺页/缺引用」——票08 扩 kind 后此句是同步文案位）。
  7. `## 指针` :69-72 —— curate skill / octo-wiki skill。
- **措辞惯例（票07/08/09 增补照此形制）**：常量**内联在散文**（`≤800 token`、`≤120 行`、`>30%` 一类阈值直接写进句子或要点），权重/判据用「## 节标题 + 要点列表 + 关键名词加粗」，页分类用 markdown 表格，纪律条用编号；无 YAML/front-matter/代码块。新增 health score 扣分公式（open findings 按 severity 加权 + 容量水位项）、窄口自动退役判据、INDEX 两级预算（80% warn/100% error）、confidence 样本不足(<3)不抖动阈值 → 各立 `##` 节（spec L110「SCHEMA.md 增补——共演文档随机制生长」；票07 AC「阈值进 SCHEMA.md 可调」）。
- 程序面：模板单源 `packages/server/src/services/knowledge/wiki/schema-doc.ts`（`SCHEMA_MD_TEMPLATE` :18+；seed **只在缺席时写入** :12-14，永不覆盖人工内容）。消费方：策展人编译前必读（index.ts:550-551 注）；`FindingOpsService.semanticRevision` 读全文入 prompt（services/knowledge/findings.ts:349-350，缺席⇒「按页格式 v3 常识执行」:350）。
- 写保护闸：`wiki/manual-files.ts` —— `MANUAL_FILE_BASENAMES` :23（user_preference.md+SCHEMA.md）；唯一写闸**路径级拒绝**（resolve 归一对拍，含 `../` 旁路形 :11-14），`ManualFileWriteError` code=MANUAL_FILE_WRITE/403 :26-33；wiki 仓 pre-commit grep 分支=纵深防御（:15-17，各钉各的测试 wiki-write-gate.test.ts）。⇒ P4 调权重=人工编辑此文件，服务只读。

---

## 6. LLM seam 先例（票06 关联判定复用面）

- **共享核**：`packages/server/src/services/knowledge/llm.ts` —— `type LLMCall = (prompt:string)=>Promise<string>` :13；`createProductionKnowledgeLLM(opts:{channel,modelEnv,defaultModel?}): LLMCall` :69-87。**离线闸语义**：**创建时**若 `OCTOPUS_KNOWLEDGE_LLM_DISABLED==="1"` ⇒ 返回恒空串调用 :74-76（调用方按「无响应」失败形态处理，**绝不静默降级** :63-65）；调用时 `getProvider("claude")`，模型=`process.env[modelEnv] ?? defaultModel ?? "sonnet"`（**逐拍读 env** :80）；provider 未配置/抛 ⇒ `console.warn([channel] provider LLM unavailable)` + 空串 :82-84。制式注 :59-67（「单测一律 fixture-mocked LLMCall，生产注入在 index.ts」= spec Testing Decisions）。
- 委托通道先例：`wiki/curator-llm.ts:18`（channel=curator）；`services/tasks/archive-ingest-llm.ts:18`（archive-ingest）；`case-extract-llm.ts:17`（case-extract）；`skill-draft-llm.ts:18/:22`（skill-propose/skill-revise）。另一降级形：`wiki/rule-form-judge.ts:22-60`（L6 warn 级——空/坏/抛一律「零 issues」绝不抛 :35-55）。
- **ArchiveIngestService summarize seam + mock 钉法**：seam 定义 `tasks/archive-ingest-service.ts:54-58`（`ArchiveSummarizer = LLMCall`，「测试一律 fixture mock 捕获 prompt」）+ deps :95。测试 `tasks/__tests__/archive-ingest.test.ts`：makeDeps 注入 `summarize: async (prompt) => { calls.push({prompt}); return SUMMARY_FIXTURE }` :167-176（**prompt 捕获断言**）；抛错⇒`skipped SUMMARIZE_FAILED`、素材包本体保留 :307-320；空串⇒SUMMARIZE_EMPTY 路 :329-333；**离线闸专测** :565-575（env=1 ⇒ 生产 summarizer 恒空 ⇒ skipped、包无总结件、零入队）。
- **finding 修订 LLM seam（同款）**：`FindingOpsService` deps.llm? :73（缺席 ⇒ `LLM_UNAVAILABLE` 503、finding 留 open :345-347）；失败形态码：空响应 LLM_UNAVAILABLE :379-380 / 坏 JSON FINDING_LLM_JSON 502 :382-389 / 涉事页未全覆盖 FINDING_LLM_PLAN 502 :396-399 / **锚点丢失 FINDING_ANCHOR_LOST 409 任务 failed 库零动** :402-407。mock 测试 `services/knowledge/__tests__/finding-ops.test.ts:143-230`（llmBad 丢锚先行断言 :160-173；成功路径 prompt 捕获 :175-204；缺 LLM 不静默 :206-220）。
- 票06 关联判定（「同类 blocker 是否再现」）即复用此族：新服务 deps 一个 `LLMCall` seam + fixture mock（prompt 捕获 + 空/坏/抛三态诚实降级）+ 生产适配器一行 `createProductionKnowledgeLLM({channel:"effectiveness-link", modelEnv:…})`。

---

## 7. jaccard / normalizeRuleText / ruleTokens 在场性

- **`normalizeRuleText`、`ruleTokens` 不存在**（全仓 packages/* Grep 零命中）。票08 spec 句「既有 normalizeRuleText/ruleTokens 先例」是**虚指**——与 P3 同款坑，钉在案：`case-symptom.ts:6-7` 勘探注「spec 所称『复用规则近义先例』在全仓不存在——无归一化/jaccard 实现可 import，本模块按 spec 字样自建」+ `__tests__/case-symptom.test.ts:5-6`（「勘探证实该先例在全仓不存在（server-sockets.md §4.2 坑）」）。
- **最接近先例（票08 D2 重复对直接复用）**：`packages/server/src/services/knowledge/case-symptom.ts` 纯函数族（零 IO 可单测）：
  - `normalizeSymptom(s: string): string` :21-26 —— 小写→NFKC 全角折半→标点符号转词界→压空白。
  - `symptomTokens(s: string): Set<string>` :29-39 —— ASCII 词段 ∪ CJK 字符二元（CJK 无空格分词最小可行形）。
  - `jaccard(a: Set<string>, b: Set<string>): number` :42-50 —— 交/并；**双方皆空=0**（防「全是标点」的畸形互并 :41）。
  - `findSimilarSymptom(existing: string[], query: string): SymptomHit | undefined` :61-71 —— 分高者胜同分先位；阈值单源 `CASE_SYMPTOM_JACCARD_THRESHOLD = 0.5` :18（「参数不是架构」:13-14）。
  - 消费方注记：`case-extract-service.ts:16`（occurrences 并档 = 归一化+jaccard）。
- 规则行文本的现成取数口：`wiki/lint.ts:250` `ruleLinesForFormCheck(body)`（锚点+规则行）。票08 建议：import case-symptom 三件套，token 源换为规则行文本，**阈值另立单源常量**（勿动 0.5 症状口径）。
- 保序判异族对照：`skill-seq.ts:12-22`（LCS/max(len)，SKILL_SEQ_SIM_THRESHOLD=0.6、MIN_EVENTS=3）——重复对是**无序语义集**，jaccard 形制对路，勿误用 LCS 族。

---

## 8. volatile / review_after 现状

- Schema 面 `packages/shared/src/types/wiki.ts`：`WikiStabilityValues = ['stable','volatile']` :10；v2 词条 schema `review_after`（YYYY-MM-DD 可选）:27 + superRefine **volatile 必带** :32-37（message 仍写「到期进审核队列」——审核队列概念已废，措辞历史残留）；**v3 页** `WikiPageFrontmatterSchema` :101-142：`stability` 可选 :111、`review_after` 可选 :112、同闸 :135-141（措辞已正为「到期复审指针」）。**case 域无 stability/review_after**（:146-149 注：判例无半衰期三问，只要求真实+source 可定位）。
- 序列化/迁移：`wiki/format.ts` :102（v2）/:264/:290（v3，在场才写行）；`wiki/redistill.ts:289` 重蒸馏保留字段。编译校验：`wiki/curator.ts:155`（计划里 volatile 缺 review_after ⇒ bad）、:166-167、:500（repairPrompt 重申此纪律）；测试钉 `wiki-curator-compile.test.ts:380-398`、`wiki-format.test.ts:81-92`/:266-269。
- **到期检查：无任何在跑实现**——`patrol.ts` 全文不读 review_after/stability（collectDrafts :205-214 六查无此项）；`wiki/lint.ts` 无到期闸；scheduler 无消费者。票08 D7（review_after 已过 ⇒ 复审 finding，续期/改写/退役三选）是**纯新建**。
- 真数据面：本机知识根在册页 front-matter 携带 volatile+review_after 的页 = **0**（grep 全 wiki 仅 `concepts/biz-glossary-shared.md` **正文**提到该字段名，其 front-matter 实为 `stability: stable`）⇒ 到期查首批输入空集，S1 必须用 `PatrolDeps.now` 时钟注入 + fixture 页构造到期（spec Testing Decisions「时间判据不 sleep」）。

---

## 9. executions JSONL（票06 解析器输入）

- **落盘面**：engine 构造 `new JsonlLogger(orgDir, executionId)`（`packages/engine/src/engine.ts:248`；orgDir 未配则无 logger）。`packages/engine/src/logger.ts`：`JsonlLogger` :59，目录 **`{orgDir}/logs/{executionId}/`** :69-72，文件 `{sanitizeId(nodeId)}.jsonl` :89-96（loop 分文件 `{loopId}-iter-N__{nodeId}.jsonl` :93；`parseLogFilename` :45-57 反解；sanitizeId :31-36）。orgDir 真实形态 = `~/.octopus/orgs/{org}/workspaces/{ws}/`，归档工作区迁至 `~/.octopus/default/archive/{ws}/logs/…`。
- 行形：每行一 JSON `{timestamp, nodeId, event, …data[, iteration]}` :110-120；事件类型（合并后制式）:5-23 = thinking_block/text_block/tool_call/bash_output/bash_stderr/python_output/python_stderr（+原始 agent_event/start/end）；append 为宏任务合并 writeSync :122-133（**同刻读盘前先 `flush()`** :143-146——票06 解析器读「刚写完的文件」的既有纪律）。
- **Read 工具调用事件形状（真实样例）**：文件 `C:/Users/EDY/.octopus/orgs/xzf-dev/workspaces/kc15-consume-20261013P2/logs/416fb856-4bad-4472-b9f9-efc46c64ce5b/wiki-consume.jsonl`（36 行，event 清点：tool_call 16/agent_event 10/thinking_block 5/text_block 3/start 1/end 1）。样例行：
  `{"event":"tool_call","nodeId":"wiki-consume","toolCallId":"toolu_c5d9584f…","toolName":"Read","input":"{\"file_path\":\"C:/Users/EDY/.octopus/knowledge/wiki/INDEX.md\"}","result":null,"isError":false,"startedAt":"2026-10-13T15:46:44.053Z","completedAt":"2026-10-13T15:46:44.053Z"}`
  ——`input`/`result` 是 **JSON 字符串**；`result` 可为 null（tool_start 合并时未回填，形制源 logger.ts:380-393）。grep 法：`grep '"toolName":"Read"' *.jsonl`。
- **wiki_refs 在池/行形状**：键与前缀单源 `packages/shared/src/types/knowledge.ts:42` `WIKI_REFS_KEY='wiki_refs'`、:45 `STALE_REF_PREFIX='stale:'`；运行时写入走 **vars_update→VarPool 唯一信道**（`engine/src/executors/parse-vars-update.ts:4-11` 三形态解析、从尾部倒扫末值优先；`executors/agent.ts:144-145` 无闸无过滤；`octopus-agent.ts:225` P1 票10 handoff 注）。落盘两处：**DB `executions.var_pool`**（= JSON.stringify(poolSnapshot)，server `services/execution/ExecutionLifecycle.ts:423/:441`）+ 引擎状态 JSON **`{orgDir}/state/{executionId}.json` 的 poolSnapshot**（engine.ts:864-880）。节点 JSONL 内 wiki_refs 一般以 text_block/thinking_block 含 `{"vars_update":{"wiki_refs":[…]}}` 引用行出现——**结构化数据权威在 DB var_pool**（patrol ②查即 `WHERE var_pool LIKE '%"wiki_refs"%'` 消费，patrol.ts:300-302）。
  - 真实样例 + grep 法：`sqlite3 ~/.octopus/db/octopus-feat-knowledge-center-20261013.db "SELECT id,substr(var_pool,instr(var_pool,'wiki_refs'),220) FROM executions WHERE var_pool LIKE '%wiki_refs%'"` ⇒ 2 行，如 id=`416fb856-4bad-4472-b9f9-efc46c64ce5b`：`"wiki_refs":["prj-open-octopus#oct-007","wf-prd-impl#oct-015","wf-prd-impl#oct-014","wf-prd-impl#oct-008","stale:wf-prd-impl#oct-008 当前已改 watch 模式无需手动 build"]`（ref 三形态 + stale 注）。**实测主 dev 库 `~/.octopus/db/octopus.db` 现为 0 行**——票06 烟测数据须从 KC 分支库取或新造真实查阅。
- **review 节点 blocker 产出形状：无现行结构化信道（事实钉）**——全仓 `review_blockers` 仅剩消费方 `packages/server/src/routes/archive.ts:58-63`：从 `state/{id}.json` 的 `poolSnapshot.review_blockers` 读 **JSON 字符串数组**（`JSON.parse` ⇒ `Array<string>`，坏形静默忽略）；引擎源码零 "blocker" 命中（无 review 节点 blocker 产出机制）；现行工作流约定 = agent 把阻塞清单写文件 `$vars.task_artifacts_dir/blockers.md`（`packages/core-pack/workflows/task-dev.yaml:72/:96`）；旧 effectiveness.ts:107 亦只读 poolSnapshot.review_blockers（生产者已亡）。⇒ 票06 的 blocker 输入面需**自定契约**（构造 fixture 执行 + 产出纪律提示），现存两先例即上列两处。
- **测试缝先例（fixture JSONL 构造）**：
  - `packages/engine/src/__tests__/wiki-refs-persistence.test.ts` —— :36 fixture 末行 `{"vars_update":{"wiki_refs":["prj-octopus#oct-001","wf-prd-impl#sop-002","stale:oct-009"],"shadow_summary":"refs-landed"}}` 经 mock agent 输出走真实执行链 ⇒ 断言 ① poolSnapshot 原样在池（含 stale 条目 :74-82）② JsonlLogger 真写 tmpdir 后 fs 读盘可追溯（:85-89）③ var_pool 文本序列化往返完好（:93-113）。票06 解析器 S1 可整族照抄此制式。
  - 直接 `new JsonlLogger(tmpDir,"test-exec")` 手造 JSONL：engine `__tests__/log-compact.test.ts:33`；server `src/__tests__/log-iteration-api.test.ts:102`。
  - 摘录形（P3 素材包消费口，非原始 JSONL）：`archive-materials` renderKeyEvent 行 `- [ts] node · event :: {json}`，解析先例 `skill-seq.ts:25` `EXCERPT_LINE_RE`——若票06 想吃 exec-jsonl-excerpt 件则用此形。
