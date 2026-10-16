# P4 wiki 进化闭环 · 探路笔记 01 — 写队列 / 唯一写闸 / revert / INDEX 预算 / 路径单源

- 基线：`eca3b4ce`（main，P3 已合入）
- 日期：2026-10-15
- 适用票：02（深回滚改造）/ 03（INDEX 分层预算）/ 04（退役链清理）/ 06（效果台账）/ 07（confidence 滚动）/ 09（自动退役-恢复）
- 主战场：`packages/server/src/services/knowledge/wiki/` + `packages/server/src/routes/` + `packages/shared/src/types/wiki.ts`
- 本文只陈述现状事实（file:line + 符号名 + 扩展钩子位），不设计实现。

## ⚠️ 头部两条关键提醒

1. **revert 现状疑已「状态重建」——票02 是整段改造，不是打补丁**：`wiki/revert.ts` 自诞生起只有一个 commit（`f5f25c97` 票12 引入，`git log --follow` 实测仅此一条，后续 P3 各修均未触碰此文件）。当前三方合并语义就是裸 `git revert --no-commit`（revert.ts:196），冲突一律 `revert --abort`/`reset --hard` 全弃（:199-202），无预检、无逐页取舍、无 --strategy 处理。票02 的改造面=`execute()` 整段（:190-300）+ S2 契约测试四条逐字断言（wiki-revert-routes.test.ts:150-167 的 git log 顶行 regex / LOG 行 regex `^## \[2026-10-13\] revert \| compile [0-9a-f]{7,}$` 与续行文案 / :199-218 冲突全弃语义）。改任何一条语义都要显式动对应断言，否则契约测试会把它钉回旧形。
2. **测试跑法（本仓惯例，implementer 必知）**：根目录 `pnpm test`（vitest.workspace.ts 全量）；只跑 server 面 = `pnpm --filter @octopus/server test`（server/package.json scripts.test = `vitest run`）。**worktree 里先 `pnpm build` 再跑测试**（CLAUDE.md 明文）。Windows 陷阱：Git-Bash 下跑 git 相关测试会因 gitconfig Permission denied 出**假红**，本仓 git/wiki 全栈测试（真 git+tmpdir 那批）建议 PowerShell 跑；孤儿进程清理见 `docs/agents/windows-pbash-trap.md`，端口拆分见 `pnpm kill:port`。仓库基线红档案见 memory「octopus-windows-git-tests-powershell」指针。

---

## 1. 全局写串行队列（ADR-0031，`docs/adr/0031-wiki-global-write-serialization.md`）

### 1.1 核心实现：`compile-queue.ts`
| 符号 | 位置 | 现状语义 |
|---|---|---|
| `WRITE_OP_KINDS` | compile-queue.ts:25-35 | **kind 单源数组**（`as const`），现九值：`ingest-compile / archive-compile / dialog-revise / lint-fix / finding-fix / revert / redistill / case-archive / page-retire`；注释点名「UI/脚本按值消费，禁各自造词」 |
| `WriteOpKind` | :36 | 类型 = 数组元素联合 |
| `QueueTaskState` | :39 | `queued → running → committed | failed`（终态集 `TERMINAL_STATES` :97）。注意 curator-task registry 自己的词是 `compiling`（curator-task.ts:25），队列面恒 `running` |
| `QueueTaskView` | :41-54 | id/opKind/label/state/`position`(仅 queued 有值，1=下一个开跑)/queuedAt/startedAt/finishedAt/`error:{code,message}` |
| `EnqueueOpts` | :56-60 | `{taskId?, label?}`——调用方自备 id 保持自有路由契约（crt-/rvt-/ret-…），缺省队列自发 `wq-NNNN`（:126） |
| `WriteLock` seam | :63-66 | 跨进程锁接口 `acquire(meta)→Promise<release>`；测试可注入假锁/关锁 |
| `WriteQueue` 接口 | :69-75 | `enqueue/get/list/depth`——消费面只依赖此接口 |
| `CompileQueue` 类 | :106-223 | 进程内 Map+FIFO 数组；capacity 默认 200（:118），超容量逐出**最老终态**任务（evict :215-222，全在跑则不逐） |
| `enqueue()` | :125-141 | 入队即返回 queued 视图；执行在 `setImmediate(pump)`（:139）——「回执先回、diff 卡后补」。id 重复抛 `QUEUE_TASK_ID_CONFLICT`（:127） |
| `pump()` | :159-189 | 单异步互斥（`this.running` 闸 :160）；**锁在执行段内 acquire**（:169）——锁占用 ⇒ 任务 failed 而非入队即拒；失败 `extractError`（:99-104，读 `err.code`，缺省 `QUEUE_OP_FAILED`）+ stderr 留痕（:175）；finally 放锁续泵（:176-187） |
| `toView()` | :191-213 | 位次 = 遍历 queued 计数至自身（:193-201） |

头注（:4-21）直接回答边界问题：读永不锁；单任务失败不堵全队；持久任务表不在本票——**真相面是 git LOG 行**。

### 1.2 第二级互斥：`wiki-lock.ts`（跨进程 wiki 根锁）
- 锁文件 `.compile.lock`（`WIKI_LOCK_FILE` :24），内容 `WikiLockPayload{pid,opKind,taskId,acquiredAt,heartbeatAt}`（:49-57）。
- 常量：心跳 2s（:30）、stale 阈值 60s（:37，理由=容忍两次满额 30s git 超时）、等待上限 300s（:44，超时报 `LOCK_HELD`）、轮询 250ms（:47）。
- `WikiLockError` code 二值 `LOCK_HELD | LOCK_READ_FAILED`（:59-64）。
- `acquire()` :124-164：`O_EXCL(wx)` 抢占（:166-174）→ 写后验（:141-144）→ stale 判定两式（PID 探活 `isPidAliveDefault` :84-92 / 心跳超时；损坏文件按 mtime 论 :176-186）→ unlink 前二读收窄 TOCTOU（:145-152）。`hold()` :205-222 心跳保活 + 只删自己的锁。
- 锁文件经 `.git/info/exclude` 排除出仓史：`excludeWikiLock()` wiki-git.ts:117-131（`ensureWikiGitRepo` :138-146 幂等补装）。

### 1.3 生产装配与路由（`index.ts`）
- 全局单例：`const wikiWriteQueue = new CompileQueue({ lock: new WikiLock({ wikiRoot: () => resolveGlobalWikiRoot() }) })` index.ts:557-559（锁 wiki 根**惰性现读**）。
- kind 清单文档注释 index.ts:553-556。
- 服务注入 `queue: wikiWriteQueue`：curatorTasks :560-566、getFindingOps :579-587、packOps :594-601、getCaseExtract :609-621、getRevertTasks :685、getRetireTasks :694。
- **惰性单例纪律**：`:681-684` 注（票14 教训）——顶层 `new …({db: getDb()})` 在 initDb() 前 import 即崩 7 个 import 级测试；新服务必须 `let xInstance; const getX = () => (xInstance ??= …)`。
- 查询端点：`createCompileQueueRoutes` 挂 index.ts:701 → `GET /api/knowledge/wiki/queue`（`{depth, running, tasks}`）与 `GET /queue/task/:id`（404 `NOT_FOUND`）——routes/wiki-queue.ts:24-46；头注 :15「只读观测，不 enqueue 不解锁」。健康条 `queueDepth` 经 `getQueueDepth: () => wikiWriteQueue.depth()` index.ts:706。
- 各服务自有 task 面：`GET /compile/task/:id`（wiki-compile 路由，挂 index.ts:590）、`GET /revert/task/:id`（:686-689）、`GET /retire/task/:id`（:695-698）。任意入队任务（含 `arc-{taskId}-rcN`、`crt-…`）都可经 `GET /queue/task/:id` 查位次/状态（pack-ops.ts:14、archive-ingest-service.ts:62、case-extract-service.ts:45 注）。

### 1.4 九类 kind 的入队点（生产者清单）
| opKind | 入队点 | taskId 形态 |
|---|---|---|
| `ingest-compile` | curator-task.ts:90 | `crt-{ts}-{seq}`（:86），registry 状态词 `compiling` |
| `archive-compile` | services/tasks/archive-ingest-service.ts:397；services/knowledge/pack-ops.ts:140-144 | `arc-{taskId}`（:62 注）/ `arc-{taskId}-rc{N}`（pack-ops.ts:129） |
| `dialog-revise` | **无生产者——预留**（compile-queue.ts:13-14 注） | — |
| `lint-fix` | **无生产者——预留**（仅测试用值：wiki-write-queue.test.ts:70,250） | — |
| `finding-fix` | services/knowledge/findings.ts:142（adopt() :130-151） | `fft-{ts}-{seq}` |
| `revert` | wiki/revert.ts:155 | `rvt-{ts}-{seq}`（:150） |
| `redistill` | wiki/redistill.ts:595 | 自发 `wq-`；ops 形态入队后**轮询至终态**（:598-611，超时抛 `REDISTILL_QUEUE_TIMEOUT`；无 queue 注入则直跑 :591-594） |
| `case-archive` | services/knowledge/case-extract-service.ts:310（入档草案）、:333（retireCase→superseded） | `ca-`/`car-` 前缀常量 :45 一带（`CASE_EXTRACT_QUEUE_ID_PREFIX`） |
| `page-retire` | wiki/page-retire.ts:179 | `ret-{ts}-{seq}`（:174） |

**registry↔队列对账模式**：queue fn 里「跑完自有 start() 后若 registry=failed 则重抛带 code」（curator-task.ts:92-97、revert.ts:157-161、page-retire.ts:181-185、findings.ts:144-148）——否则队列误记 committed。读时对账 `get()`：revert.ts:111-126、page-retire.ts:122-135、findings.ts:154-167 把「执行段 acquire 即拒（锁占用）」的队列 failed 收敛进 registry；**curator-task.get()（:102-104）无对账**（fact，UI 若直查 crt- 任务面需自补）。

### 1.5 单 commit 收口模式（所有写通道的共同收口段）
- 单页/批页编译：`git add -A` → `status --porcelain` 判脏 → `commit` → `wikiHead()`：compile.ts:564-574（`compile: {relPath} — {note} [review:{ref}]`）、:797-808（批通道 `${action}: ${entry} — ${note}`）、:985-993（判例）、:1209-1219（v3 页）。
- revert：revert.ts:281-291 `revert: {hash} — 回滚本次编译`；零 diff 兜底返回现 HEAD 不抛（:284-287）。
- retire：page-retire.ts:297-309 `retire: {relPath} → _retired/（superseded）`。
- append-only 拒绝证据行：compile.ts:1002-1018（LOG 行 + best-effort `compile-rej:` commit）。

### 1.6 新增 opKind 的注册点（全清单）
1. compile-queue.ts:25-35 数组追加 + 头注 :11-14 kind 计数行同步。
2. **wiki-write-queue.test.ts:89-99 S1 逐字 `expect(WRITE_OP_KINDS).toEqual([...])`**——不改即红（契约测试钉死枚举全序）。
3. index.ts:553-556 文档注释 kind 词表（惯例，非闸）。
4. 生产者服务：`queue.enqueue("<kind>", fn, {taskId,label})` + 自有 registry（复用 §1.4 的 fn 重抛 + get 对账两件套）。
5. index.ts 惰性单例 + `app.route("/api/knowledge/wiki", …)`（抄 :685-698 revert/retire 形状）。
6. 新执行体落盘只准调 `WikiCompileService` 四管线（§2），禁自拼 fs 写。

---

## 2. 唯一写闸 + 人工文件写保护（ADR-0030）

### 2.1 写路径收口
- 头注定言「编译服务是 wiki 唯一写入口（spec D4 技术收口）」：compile.ts:26-35。
- `WikiCompileService`（compile.ts:378）四管线：`compileEntry` :419（按 `parseWikiFile` kind 分派 :420-422）、`compilePage` :1063（v3 页）、`compileCase` :844（判例 append-only）、`compilePages` :592（批通道=票06「单次编译」互斥单位，头注 :67-70）。
- 管线步骤序（validate→快照→fs 写→INDEX 重建→LOG append→DB/FTS 单事务→commit→失败补偿）：单页 :426-582、批 :597-833、页 :1066-1227。补偿 `rollbackTo()` :1229-1257（fs 快照还原 + DB upsert/delete 补偿 + `git reset` best-effort）；批补偿 :809-832。原子写 `atomicWrite()` :153-164（tmp+rename）。
- DB 面：`WikiArticleDAO` upsert + `deleteFts/insertFts` 手工对齐；**FTS 失败非致命**（swallow+warning，gotcha #6：:557-561、:790-793、:979-982、:1203-1206）。DB `domain` 列存 v3 type 值（:765 注释、:1173-1177）。
- 判例可变面四字段 `status/rule_ref/occurrences/procedural`（:902-916），其余改写先落 `case-rej` LOG 证据行再抛 `CASE_APPEND_ONLY`（:897-909）；逐字节相同重入库 = no-op（:917-920）。

### 2.2 人工文件保护（主闸在服务层）
- `manual-files.ts`：`MANUAL_FILE_BASENAMES = ["user_preference.md","SCHEMA.md"]` :23（**单源**，头注 :19 令 pre-commit/file-ops 消费此值勿硬拼）；`ManualFileWriteError` :26-33（code `MANUAL_FILE_WRITE`、status 403）；`manualFilePositions()` :39-46 四式合法位（wiki 根 + 知识根各两式）；`isManualFileTarget()` :53-56 resolve 归一 + lowercase 对拍（`../user_preference.md`、`topics/../SCHEMA.md` 旁路同拦）。
- 闸位：`assertNotManualFile()` compile.ts:404-410，调用点 :430（v2）、:624（批）、:847（判例）、:1069（v3 页）；**先于** FILE_NAME_RE（:115 定义）与逃逸检查（:436 等）——错码不退化 INVALID_PARAM（manual-files.ts:12-13 明文）。
- pre-commit 纵深：`WIKI_PRE_COMMIT_HOOK` wiki-git.ts:67-84——①缺 `OCTOPUS_WIKI_COMMIT_SOURCE` 标记拒（旁路提交）；②非 manual 标记触及 `(user_preference|SCHEMA)\.md` 拒（:78 grep 分支）。`spawnGit` 默认带 `curate` 标记 :38-53；`installWikiPreCommitHook` :87-100 幂等装机。已知边界注 :17：`--no-verify` 可绕，防呆不防恶意；:60-65：该分支生产布局常态不可达（人工文件不入 wiki 仓），主闸在服务层。
- SCHEMA.md 本身：`schema-doc.ts:96-102 ensureSchemaDoc()` 只在知识根**缺席时 seed** 模板（:12「自动通道永不覆盖」）；模板全文 :18-90（编译纪律六条/工作流/命名法都在里面，是纪律文字单源）。
- 双层行为测试同钉：wiki-write-gate.test.ts:17-34 头注（①服务层硬闸 ②pre-commit ③通道负断言）；真 git fixture `rawGit()` :44-50（可控/摘除标记 env）。
- INDEX 必读行只是**指向**人工文件（compile.ts:128-135 `WIKI_INDEX_MUST_READ_LINE`，D-kc15-2：`../user_preference.md` = 知识根位，行内注「写闸对该文件本体任何通道写仍拒（红线5）」）。

### 2.3 `_retired/` 与 `replaced_by` 语义现状
- `_retired` 目录常量：global-paths.ts:34 `WIKI_RETIRED_DIR`；骨架创建 paths.ts:83-87（v3 五类 + `_retired`，**不再创建 v2 域目录**，票08 注 :76-81）；`hasWikiContent` 扫面含 `_retired`（:140）。
- 页退役 = `page-retire.ts`：迁 `_retired/<原相对路径>`（execute :253-262，先写新位再删原位「归档先于删除」:253-254 注）、front-matter 注 `status:"superseded"`（:250）、可退目录白名单 `RETIRABLE_DIR_RE` :78（仅 entities/concepts/topics/sources 一层 .md；cases 走判例 status、v2 走重蒸馏）、人工文件拒退 :162-165、失败尽力回迁 :314-324。**`_retired/` 不在 scanWikiEntries 面**（compile.ts:226-228 注释）⇒ INDEX/搜索自动摘除。
- 重蒸馏 v2 退役：`_retired/v2/` + 台账 `_retired/v2/redistill-map.json`（paths.ts:72 `REDISTILL_MAP_REL`；redistill.ts:626-637 迁移+台账落盘）。
- 锚点永不复用对退役面的延伸：`retiredLedgerAnchors()` compile.ts:220-230（台账 anchors + `collectRetiredAnchors()` :233-256 递归扫 `_retired/**/*.md`）并入 `nextRuleAnchor()` :264-270 发号空间——**票09 若要「恢复」页，恢复后锚点已在此空间、页回在册面即自然衔接；但现无任何 restore/un-retire 服务**（page-retire 单向；:314-324 只是事务补偿）。
- **`replaced_by` 未在代码实现**：全仓唯一出处是 persona 纪律文本 `packages/server/src/services/agent/builtin-clones.ts:62`（「supersedes 旧规则迁 _retired/ 带 replaced_by」）；`WikiPageFrontmatterSchema` 无此字段（只有 `status: superseded`）。判例侧的对应物是 `rule_ref`（shared wiki.ts:170）。扩展钩子位 = shared/src/types/wiki.ts:101-142（ADDITIVE 可选字段先例见 :116-119 status）。
- superseded 双词表：页 `["superseded"]`（:119）与 case `['open','distilled','superseded']`（:151）互不干涉（:117-118 注）。

### 2.4 LOG 行格式族（grep 点）
- 行构造单源：`formatLogRow()` compile.ts:374-376 →
  `## [YYYY-MM-DD] {action} | {entry}\n  → {note} · {source} · {reviewer} ✓\n`
- 头：`WIKI_LOG_HEADER` :123-125（append-only 声明 + grep 提示）；文件名常量 `WIKI_INDEX_FILE`/`WIKI_LOG_FILE` :118-119。
- **现存 action 生产者**（grep `action: "` 全量）：
  - `compile`：compile.ts:525（v2 单页）/:948（判例，参数化）/:1171（v3 页）；findings.ts:323、:486（裁决即编译）；redistill.ts:647（批通道复用 action "compile"，entry=`redistill: v2→v3（N 页）`）。
  - `ingest`：curator.ts:650（策展批通道 batchOpts.action=`"ingest"`，票05 契约；revert 测试 :160-165 依此断言原行消失）。
  - `revert`：revert.ts:233-238（`entry: compile {short7}`、note「回滚本次编译」、source「git revert」、reviewer「owner」）。
  - `retire`：page-retire.ts:274-280（`entry: relPath`、note「退役入 _retired/ [ · reason]」、source「dialogue」）。
- **`query`/`lint` 无生产者**——只存在于纪律文本（:370 注释、schema-doc.ts:59）与读面过滤示例（knowledge-read-routes.test.ts:289 `op filter … ingest/compile/query/lint/revert 口径`）；票06 预留 kind `lint-fix`/`dialog-revise` 也不落 LOG 词（尚无实现）。
- 读侧解析：routes/knowledge-read.ts `LOG_LINE_RE` :50、`LOG_RESULT_RE` :51、`parseLogLines` :60-73、`GET /api/knowledge/log?op=` :142-154（无 LOG.md 时诚实空态 :149）。
- v2 旧表格行共存可读、机械转换已封 git 史（compile.ts:121-122、knowledge-read.ts:48）；redistill.ts:639-640 `convertLegacyLog` 是闸前一次性改写（注释 :638）。

---

## 3. revert 服务现状（票02 改造对象）

文件：`packages/server/src/services/knowledge/wiki/revert.ts`（351 行全量读过）。**改造面提醒见头部提醒 1。**

### 3.1 形状
- `RevertTaskService` :84；deps :73-82（`root?` 知识根注入、`git?` GitRunner、`queue?` WriteQueue——缺省私有 `new CompileQueue()` :102，生产注入全局单例）。
- 入口 `revert(commit)` :136-164：同步校验三连——形制 `COMMIT_RE /^[0-9a-fA-F]{7,40}$/` :70/:138（INVALID_PARAM 400）→ `.git` 存在 :141-143（NOT_FOUND 404）→ `rev-parse --verify {c}^{commit}` :144-147（不在仓 404）；建 registry `rvt-…` → `queue.enqueue("revert", fn, {taskId, label: target.slice(0,9)})` :155-163。
- 状态机 `RevertTaskStatus` :49（同队列四态）；`start()` :166-183；结果面 `WikiRevertResult` :39-47（target/revertCommit/touched/ftsWarnings）。

### 3.2 `execute()` 执行体 :190-300 —— 错误码产生点
| 码 | 产生点 | 触发条件 |
|---|---|---|
| `WORKTREE_DIRTY`(409) | :191-194 | `git status --porcelain` 非空（「不应发生：写闸全提交」） |
| `REVERT_CONFLICT`(409) | :196-202 | `git revert --no-commit <target>` 非零 ⇒ `revert --abort`，abort 也败则 `reset --hard HEAD`（:199-200），stderr 末行入错文 |
| `LOCK_HELD` | **不在本文件产生**——队列 pump 执行段 `lock.acquire` 抛 `WikiLockError`（compile-queue.ts:169 → wiki-lock.ts:157-160），registry fn 未起跑即 failed，`get()` 读时对账收敛 :111-126 |
| `REVERT_FAILED` | :175/:290 兜底码（HEAD 不可读等） |

### 3.3 三方合并语义现状（票02 要动的核心）
- 「三方合并」即裸 `git revert --no-commit`（:196）——**无预检、无部分回滚、无 --strategy/ours 处理**；冲突一律全弃（abort→reset），不做逐页取舍。
- 触及清单 :204-218：`diff --cached --name-status`，R/C 行取末段新路径（:210-212）；`INDEX.md`/`LOG.md` 剔出页清单（:213）；action 三值 `removed(D)/readded(A)/restored(M等)`（:216）。

### 3.4 INDEX/LOG/FTS/DB 四同步的分工（事实表）
| 面 | 由 git revert 带回 | 程序化 |
|---|---|---|
| 页文件 | ✅（工作区回退，:196） | — |
| INDEX.md | git 会连带回退旧 INDEX，但随即被**全量重建覆盖** :223-228（`scanWikiEntries`+`renderBudgetedWikiIndex`+`writeAtomic` :314-318） | ✅ 真相 |
| LOG.md | 历史 compile 行随 git revert 消失（测试 :163-165 断言此反转） | 新 revert 行程序化 append :230-239 |
| DB(wiki_articles)+FTS | ❌ git 不管 | ✅ 逐页重同步 :241-279：在盘→upsert+FTS 删重写；不在盘→按 `path` SELECT 找 id 删行删 FTS；解析坏页跳过+stderr（`entryRowFromDisk` :328-351，confidence 兜底 0.5 :343） |
| commit | `add -A` + 单 commit `revert: {7位} — 回滚本次编译` :281-291 | 零 diff 兜底 no-op :284-287 |
- 异常路径 :292-299：非冲突类异常也尽力 `revert --abort`/`reset --hard` 后重抛。
- raw/ 零触碰（头注 :29）。

### 3.5 路由与契约测试
- `routes/wiki-revert.ts`：`POST /revert` :31-50（202 `{taskId,commit,status:"queued"}`；`RevertError.status` 映射同步段 400/404）；`GET /revert/task/:id` :52-59。头注 :19-20：**执行级失败（REVERT_CONFLICT/LOCK_HELD/WORKTREE_DIRTY）不改 HTTP 码**，落任务 failed。
- 契约测试 `routes/__tests__/wiki-revert-routes.test.ts`（头注自名「票12 · S2 revert 路由契约」:17-25）：
  - AC5 主链 :111-173，断言形状——202 ack（`taskId /^rvt-/` :124）→ `waitRevert` 轮询 helper :56-65 → `result.revertCommit` 40hex 且 ≠target :131-132 → touched 三页 action="removed" :134-139 → GET task 形状一致 :141-146 → **git log 顶行 `/revert: [0-9a-f]{7,}/` :150-152 → 页删+raw 仍在 :153-156 → INDEX 不含 con-a :157-159 → LOG 原 ingest 行消失 + `^## \[2026-10-13\] revert \| compile [0-9a-f]{7,}$` 逐字 regex :160-166 + 续行 `→ 回滚本次编译 · git revert · owner ✓` :167 → DB 行空 + FTS MATCH 空 :168-172**。
  - 错误码面 :175-197（含「校验失败不建任务」`revertTasks.list()===0` :192）。
  - REVERT_CONFLICT :199-218（人工 commit 造后写冲突；断言工作区仍干净 + 页含人工补充——**改造后此语义要么保留要么显式改契约**）。
  - LOCK_HELD :220+（注入即拒假锁）。全栈 fixture：真 fs tmpdir + in-memory DB + 真 git（`realGit` :28-33，带 curate env）+ mock LLM PLAN :35-43（跑法见头部提醒 2）。
- 队列级 S1：`wiki/__tests__/wiki-write-queue.test.ts`（头注 :17-23「票06 · S1，并发必须真并发、Expected 从票面独立推得」）——FIFO/位次 :36-65、失败不堵队 :67-83、枚举逐字 :85-100、锁段（S1 组②）:103+（死 PID 探活 :115-120、真双进程 spawn）。
- 路由级队列契约：`routes/__tests__/wiki-queue-routes.test.ts`（S2 头注 :18-21，queueDepth「只换值不换形」纪律）。

---

## 4. INDEX 预算闸与渲染（票03 对象）

### 4.1 预算与估算
- `WIKI_LIMITS`：lint.ts:18-26——`INDEX_MAX_TOKENS: 800`（:24）；同表 ENTRY_MAX_LINES 120 / ENTRY_MAX_RULES 25 / ENTRY_MAX_TOKENS 2000 / HUB_MAX_LINES 40 / H2_MAX_RULES 10 / CODE_BLOCK_MAX_LINES 20（阈值逐字 prototype Tab③「增长约束」表，头注 :17 独立真相源纪律）。
- `estimateTokens()`：lint.ts:57-65——CJK 1 字≈1 token、其余非空白 4 字符≈1 token（确定性启发式，无 tiktoken）。

### 4.2 渲染形态（当前三节）
- `renderWikiIndex(entries, org, optionalEntries)`：compile.ts:289-328
  - L1 `# Octopus Knowledge Wiki — {org}` :291；导航协议 blockquote :292（「先读索引→选页整读→未命中再 search API，禁止全库遍历」——octo-wiki skill 的读协议对偶）。
  - `## 必读` 节 :294-295：恒一行 `WIKI_INDEX_MUST_READ_LINE`（:135，`../user_preference.md` 指知识根，D-kc15-2 语义注 :128-134）。
  - 五类正文节 :302-317：`## Entities (N)` 等（题头计数；标签单源 `WIKI_PAGE_GROUP_LABELS` paths.ts:56-62）；行式 `- {relPath} — {summary}`，entity/concept 注 `←N 源`、topic 注 `· 硬约束 ×N`、source/case 裸行（头注 :286-288 逐字 prototype Tab② 样例契约）。
  - `## Optional （低频页 · 预算溢出自动降级）` 节 :319-325：行 `- {relPath} — {title}`（无 summary——注意这是溢出行的现形态）。
  - hub 子页第一跳不列：`isHubChild()` :276-279（`dir/hub/xxx.md` 且有 README ⇒ 摘出可见面，计数仍入统计）。
- `renderBudgetedWikiIndex(entries, org) → BudgetedIndex{content, optionalRelPaths, overBudget}`：compile.ts:342-366——降级序=**锚点数最少优先、同级按路径 localeCompare**（:348-350）；while 循环逐一移入 Optional 直到 ≤800 或只剩一页恒见（guard 1000，:354-364）；仍超 ⇒ `overBudget` :365。接口注释 :330-336（「病态巨行——调用方须拒写」）。

### 4.3 L4 闸的调用点（预测式，四写点 + 三重建点）
| 用途 | 位置 | 备注 |
|---|---|---|
| 闸·v2 单页 | compile.ts:479-492 | 预测=现库剥本条+新条（:481-482）；overBudget ⇒ `WikiLintError L4_INDEX_BUDGET` **+拆分建议** `overflowSplitSuggestion()`（:1025-1055，取锚点最胖页按 H2 切 hub 计划；判例不参与 :1042） |
| 闸·v3 单页 | :1127-1139 | 同上（含 suggestion） |
| 闸·批通道 | :693-706 | 整批合并预测（剥批覆盖旧页 :694）；overBudget ⇒ 抛错但 **无 suggestion**（:701-705 未传参——fact） |
| 重建·写后 | :522 / :747 / :945 / :1168 | 写完直接 `renderBudgetedWikiIndex(全库).content`——**写后段不再检 overBudget**（依赖预测段已拒；溢出降级在此自动生效） |
| revert/retire 重建 | revert.ts:223-228、page-retire.ts:266-269 | 同函数复用 |
- 判例管线 compileCase **无 L4 预测闸**（:844-928 全程不 renderBudgeted 预测——case 行恒裸，INDEX 增长对 case 不设闸，fact）。
- 编译失败回滚（自纠环）与 L4 的交互：curator.ts:657-704 —— 服务层自纠**只识别 L5 日期类**（`isDatesLintFailure` :273-275，判 `L5_DATES_IN_BODY`）；`L4_INDEX_BUDGET` 非日期类 ⇒ :667 原样上抛 ⇒ 任务终态 failed（批通道本无 suggestion，策展人侧只拿到错误文）。计划校验自纠（另一环）:496 注。`WikiLintError` 形状（findings + suggestion 字段）：lint.ts:38-51；拆分出口纪律「随错误返回、**无入队语义**」compile.ts:109-112、lint.ts:11-12。
- llms.txt 惯例在场证据（全在治理/文档面，代码注释无此词）：`.scratch/llm-wiki-loop/prototype.html:467,505,592`（Optional 节=llms.txt 惯例、L4 行）、`.scratch/llm-wiki-loop/spec.md:26`（故事9「程序重建 llms.txt 风格、含 Optional 节、≤800」）、`.scratch/wiki-evolution/spec.md:56`（故事25「预算约束的是第一跳恒见部分」——票03 的直接规格）、`.scratch/wiki-evolution/issues/03-index-budget-tiers.md:12`、`GLOSSARY-MAP.md:135`。
- L4/INDEX 测试群（文件:行）：
  - `wiki-lint.test.ts:244-281`（溢出自动降级放行 :246-273：`toContain("## Optional")` + 恒见段 ≤800；病态巨行拒写 `/L4_INDEX_BUDGET/s` :274-281）
  - `wiki-migrate.test.ts:345,362,377-382`（35 短源推爆 → L4 拒写台账 + INDEX `estimateTokens ≤800`）
  - `wiki-compile.test.ts:125-152`（INDEX v3 分组形状逐字断言）、`:172-235`（回滚后 INDEX 还原/重建面）
  - `wiki-batch-compile.test.ts:95-108,151,165-185`（commit 含 INDEX.md；失败回滚 INDEX 字节不变）
  - `wiki-curator-compile.test.ts:147,161,361-372,418`、`page-retire.test.ts:126`、`wiki-revert-routes.test.ts:157-159`、`wiki-global-move.test.ts:73,183,200`
  - 票03 分层改渲染时，以上逐字行式断言全部是回归面。

---

## 5. 知识根路径单源

### 5.1 `global-paths.ts`（解析族全量）
- 优先级头注 :14-17：**参数注入 > `OCTOPUS_KNOWLEDGE_DIR` > `~/.octopus/knowledge`**；`OCTOPUS_WIKI_DIR` 为**弃用别名**（票01 时代钩子），单源定义 `legacyWikiDirEnv()` :167-169（「迁移完存量钩子后整体删除」）。
- `octopusHome()` :44-46 = `$OCTOPUS_HOME ?? ~/.octopus`（假 home 窗）；`octopusHomeFor(injectedHome)` :127-129。
- `resolveKnowledgeRoot(injectedRoot?)` :51-55；`getRawRoot`/`getRawDir`/`getGlobalWikiRoot`/`getSkillDraftsRoot` :58-78；`ensureKnowledgeSkeleton` :86-94（mkdir -p 全骨架含 drafts/skills :41）。
- 全局轨：`resolveGlobalKnowledgeRoot()` :104-106、`resolveGlobalWikiRoot()` :109-111、`GLOBAL_WIKI_ORG = "global"` :117（DB org 钉值，schema 不动语义全局）。
- org 轨/兼容 derive 族（code-review S3 收口，file-ops 与 wiki/paths 全委托不再自拼 :20-22）：`deriveKnowledgeRootAt` :132、`deriveWikiRootAt` :137、`deriveOrgKnowledgeDirAt` :142、`deriveOrgWikiRootAt` :147、`resolveKnowledgeDir(org?)` :156-160（env 拍平吞 org 参数——旧语义逐字保留；纯解析零 mkdir 票09 护栏）。

### 5.2 `wiki/paths.ts`
- `resolveWikiRoot(org?, injectedRoot?)` :27-33：injected > `OCTOPUS_WIKI_DIR` 别名 > 无 org→全局 > org 旧轨。
- `resolveWikiRootCompat(org?, injectedRoot?, injectedHome?)` :158-166：搬家窗口语义（全局根有内容只读全局；否则兼容旧 org 轨；`hasWikiContent` 判据 :134-146——**骨架≠内容**）。
- 目录常量：`WIKI_DOMAINS`（v2 五域）:36、`WIKI_ALL_DIRS`=v3∪v2 :65、`REDISTILL_MAP_REL` :72、`ensureWikiSkeleton` :83-87、`V2_LEGACY_DOMAINS`/`removeEmptyV2DomainDirs` :94-127（票08 一次性清理，cases 物理隔离绝不删 :90-92）。

### 5.3 测试覆盖 env 的三种形态（新测试选路用）
1. **构造器注入 tmpdir（主流）**：wiki 测试群全部 `new WikiCompileService({ db, org:"testorg", rootDir: tmpRoot, git: realGit(root) })`（wiki-compile.test.ts:91、wiki-lint.test.ts:79、wiki-batch-compile.test.ts:62、wiki-page-v3.test.ts:135、wiki-cases.test.ts:116、wiki-write-gate.test.ts:156-196…）；服务级 `root` 注入（revert.ts:97 deps.root、page-retire.ts:113；fixture 见 wiki-revert-routes.test.ts:78-96 `mkdtempSync(tmpdir()/kc-revert-api-)`）。
2. **`OCTOPUS_KNOWLEDGE_DIR` 设置/删除**：file-ops.test.ts:94-121、:203-273；ingest-routes.test.ts:202-220；knowledge-root.test.ts:45-64（拍平 ≡ resolveKnowledgeDir(org) 钉死）。
3. **假 home 窗**：`OCTOPUS_HOME` / `injectedHome`——knowledge-root.test.ts:30-36（三 env 存档-恢复纪律 :24-36，防串污染）、`resolveWikiRootCompat` 注入窗钉「注入 fake home 时 env 让位」:110-111。
- 生产装配读点：index.ts:558（锁内 `resolveGlobalWikiRoot()` 每 acquire 现读——**wiki 根可在首编译前不存在**，wiki-lock.ts:67 注）；reconcile 的 env 种子读法参考 wiki-reconcile.test.ts:212。

---

## 附：票↔插座速查
- 票02（深回滚改造）→ §3 全部 + 头部提醒 1/2；改 `execute()` 冲突语义必同改 wiki-revert-routes.test.ts:166 LOG 逐字 regex 与 :199-218 冲突断言；新终态词须对齐 `QueueTaskState`（compile-queue.ts:39）。
- 票03（INDEX 分层预算）→ §4；渲染单源 `renderWikiIndex`/`renderBudgetedWikiIndex`（改形状=动 compile.ts:289-366 两处 + 四预测点三重建点同函数）；恒见预算口径=故事25（wiki-evolution spec.md:56）。
- 票04（退役-断链清理）→ §2.3（`_retired` 面、`RETIRABLE_DIR_RE`、断链闸 lint.ts:217/:436 L5_LINK_BROKEN、linkCorpus 构造 compile.ts:670-691/:1111）；恢复语义无现成插座（§2.3 末 fact）。
- 票06（效果台账）→ §1（新增 opKind 注册点六步 §1.6；registry 对账两件套 §1.4）。
- 票07（confidence 滚动）→ §2.4（LOG 行生产者表——新 action 词读侧 parseLogLines 无需改，op 任意 `[A-Za-z0-9+_-]+`）；confidence 面=§2.1/§2.2 表：v3 optional（shared wiki.ts:115）、DB 兜底 0.5（compile.ts:772/:1184）、case 恒 1（:960）、revert 重同步同兜底（revert.ts:343）。
- 票09（自动退役-恢复）→ §2.3 + §1.6（`page-retire` 已有通道；恢复=新 opKind 或扩 page-retire 反向执行体，钩子位 RETIRABLE_DIR_RE/_retired 写权闸 compile.ts:233 递归扫面）。
