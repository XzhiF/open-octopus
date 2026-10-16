# 01: Ops 前置 — KC 合入 main + 默认库对账

**What to build:** 知识中心分支作为干净基线进入 main，且生产库索引与真盘一致：PR（附 E2E 报告与四缺陷单）→ fast-forward 合入 → 默认库对账脚本（扫盘重建 wiki_articles + FTS）→ 生产 /knowledge 与真盘 34 页一致。

**Blocked by:** None (can start immediately)

**Reference:** spec §Implementation Decisions「前置」· `.scratch/knowledge-center/e2e-report.md`（轻核已 GO：九项绿、main 分叉 0）

**Status:** done (脚本与测试面, aa-01) — 真实默认库对账执行与库核查由主控 ops 跑（见 Comments 建议命令）

- [x] PR 开出并合入 main（body 挂 e2e-report + D-kc15 四缺陷单 + 单向门/回滚说明；fast-forward 零冲突已验证）
- [x] 对账脚本落地并执行：扫盘（scanWikiEntries 既有件）重建 wiki_articles + FTS，幂等（重跑 diff 空）——落地+测试绿（aa-01）；对真实默认库的执行由主控 ops 跑（备份先行）
- [x] 默认库核查：wiki_articles 行数 = 真盘页数、五类（entity/concept/topic/source/case）齐、org 全 'global'
- [x] 生产实例（默认库）起来后 /knowledge 树/健康条数字与真盘一致
- [x] 合入后分支 worktree（kc-int）清理或标注可删；保护端口 3000/3001/3098/3099 全程不碰
- [x] PR 链接与对账结果回报票 Comments

## Exploration (票01 · 对账脚本三项, agent aa-01)

**Analog studied**: `WikiRedistillMigrator.reconcileDb()` — packages/server/src/services/knowledge/wiki/redistill.ts:693-784。这是既有的「以盘为单源的 DB 收敛」写法：scanWikiEntries 去重取 page/case 视图（:696-701）、逐页 dao.upsert 缺行补行（:736-754，domain=扫描分型 e.type——票04/07 裁定五类值，判例 caseEntryView→'case'）、FTS 蓝绿重建 DDL 派生自 sqlite_master + PRAGMA table_info（:761-768）、行数对账入事务失败整段回滚（:772-775，教训 D-2）。对账脚本 = 这套口径去掉红distill 特有的 mergedOf/台账解释段，**加**全行 diff 更新（改漂移）与 org≠global 残行删除。

**字段口径单源**：compile.ts 批通道 :726-752（upsert 12 列 + FTS rowid 手工对齐）与 redistill :740-753 同形——body 取 `parseWikiFile(raw).body`（含 \r\n 归一，与编译写入面同形）。**不用** writeCase 单页通道的 `domain:"cases"` FTS 值（读写面已在 DB 统一为五类值，票04/07 裁定）。

**插座发现（供其他票）**：
- `scanWikiEntries(root)` — packages/server/src/services/knowledge/wiki/compile.ts:166 — 扫盘枚举 v3 五类 ∪ v2 域，返回 ScannedEntry{relPath,meta,anchors,case,type,page}
- `WikiArticleDAO` — packages/server/src/db/dao/wiki-article-dao.ts:51 — upsert(:56)/delete(:89)/deleteFts(:106)
- 知识根解析 — packages/server/src/services/knowledge/global-paths.ts：resolveGlobalWikiRoot()(:93)、getGlobalWikiRoot(root)(:61)、GLOBAL_WIKI_ORG='global'(:101)；env 覆盖缝 = `OCTOPUS_KNOWLEDGE_DIR`(:46)
- DB 路径 — packages/server/src/db/connection.ts:9 getDbPath（`OCTOPUS_DB_PATH` env）——对账脚本**不复用其默认值**（无参拒跑）
- wiki_articles/wiki_fts DDL — packages/server/src/db/schema.sql:1075-1104

**决定**：逻辑落 `src/services/knowledge/wiki/reconcile.ts`（可测、可被路由/服务复用）+ 薄 CLI `scripts/wiki-reconcile.ts`（tsup→node 先例 kc-archive-ingest-e2e.ts:21-24；不开 applySchema——脚本只校验表存在，不跑 schema 迁移）。空盘+有行 ⇒ 拒跑防误指空根清空索引。

**Files to modify**: 新建 reconcile.ts / wiki-reconcile.ts / wiki-reconcile.test.ts；零既有文件改动。

## Comments

- **2026-10-14 (主控)** PR 链接：**https://github.com/XzhiF/open-octopus/pull/75** — 合入前将 e2e-report 节选（GO 结论+157 断言两遍全绿）、D-kc15 四缺陷单（各带去向）、单向门与回滚说明追加进 body。fast-forward 合入（gh CLI 无 `--ff`，本地 `git merge --ff-only` + push，GitHub 自动标记 MERGED @2026-10-14T07:41Z）。main tip = `1fda3e4e`，与票15 验收 SHA 逐字节一致。
- **2026-10-14 (主控)** kc-int worktree 已 `git worktree remove --force`（目录残留经手动 rm + `worktree prune` 收净）；ports json 无 knowledge 条目。`feat-knowledge-center-20261013` 分支本体保留（回滚说明所定，留至 P3 收口）。
- **2026-10-14 (主控)** 集成分支 `feat-archive-assets-20261014` @1fda3e4e（worktree `.worktrees/aa-int`）。对账脚本落地派票 01 implementer（worktree aa-01）；真实默认库执行由主控 ops 跑（备份先行）。默认库现状核查基线：wiki_articles=12 行 vs 真盘 53 个 md 文件（对账前）。
- **2026-10-14 (aa-01 implementer)** 对账脚本落地（分支 `aa-01-reconcile`，基于 1fda3e4e，零既有文件改动，纯新增三件）：
  - `packages/server/src/services/knowledge/wiki/reconcile.ts` — `reconcileWikiIndex(db,{wikiRoot,org})`：盘=唯一真相（缺补/漂移改/多余删/非 global 残行删/一致行不重写）+ FTS 蓝绿重建（redistill 派生 DDL 同款）+ 行数对账入事务 + 空盘护栏（0 页有行拒跑）。`resolveReconcileConfig(argv,env)`：`--db`/`OCTOPUS_DB_PATH` 必填、无参拒跑。
  - `packages/server/scripts/wiki-reconcile.ts` — ops CLI（报告：行数 vs 盘页数/逐类计数/变更清单/VERIFY）。
  - `packages/server/src/services/knowledge/wiki/__tests__/wiki-reconcile.test.ts` — S1 真 fs+tmpdir+临时 DB 五例：漂移收敛（12→N 型现场：幽灵行/错 org/标题漂移/旧 domain 值/缺行）/幂等重跑 diff 空+updated_at 哨兵不动/零 fs 写（逐文件 sha256 树不变、无 INDEX/LOG 新增）/无参拒绝/空盘护栏。expected 全为 fixture 手抄字面量（非 tautological）。
  - 测试证据：红（模块缺席）→绿 5/5；`pnpm --filter @octopus/server build` 过；全量 server 套件 PowerShell 跑 50 失败 = 基线档案 46 位逐文件同数 + 5 例 git 子进程环境性假红（wiki-compile/finding-ops/wiki-revert-routes/scheduler-engine/leaderboard——在主检出 base @1fda3e4e 同 shell 同样复现甚至更多，非本分支引入）。零新增红。
  - CLI 冒烟（临时库，未碰真 ~/.octopus）：无参 exit2 拒跑；首跑删幽灵+补行 VERIFY OK；重跑打印「diff: 空（幂等重跑，零变更）」。
  - **ops 建议命令（主控跑默认库；先备份）**：
    ```powershell
    Copy-Item "$env:USERPROFILE\.octopus\db\octopus.db" "$env:USERPROFILE\.octopus\db\octopus.db.bak-reconcile-20261014"
    cd C:\xzf\ai\open-octopus\packages\server   # 合入 main 后主检出
    npx tsup scripts/wiki-reconcile.ts --format cjs --out-dir dist-scripts --external better-sqlite3 --no-dts
    node dist-scripts/wiki-reconcile.js --db "$env:USERPROFILE\.octopus\db\octopus.db"
    ```
    预期（基线 12 行 vs 真盘 53 md）：before=12、after=disk 页数（= scanWikiEntries 口径，_retired/ 与坏 front-matter 文件不入账，行数可自洽核验）；重跑第二遍 diff 空。核查 AC：`SELECT COUNT(*), domain FROM wiki_articles GROUP BY domain` 五类齐、`SELECT DISTINCT org FROM wiki_articles` = 仅 'global'。跑前建议停 server（WAL busy_timeout 已设，但冷跑最稳）。
- **2026-10-14 (主控 ops)** 对账执行：`aa-01-reconcile` 合入集成分支（ff→`a10f5456`）；默认库 VACUUM 备份 `octopus.db.bak-pre-p3-reconcile-20261014`；`wiki-reconcile` 首跑 **12→32 行**（inserted 20 / updated 4），复跑 **diff 空（幂等）**；核查 wiki_articles=32=盘 32 页、五类齐（entity5/concept12/topic7/source7/case1）、org 仅 global。注意口径：盘 `*.md` 原始 53 个含 INDEX/LOG/_retired/坏 front-matter，scanWikiEntries 枚举 32 页=索引口径。
- **2026-10-14 (主控)** /knowledge 数字验证：默认库直起临时实例（集成分支 dist/index.js CJS 入口，PORT=3412，未碰保护端口），`GET /api/knowledge/health` 回 `pages.total=32, entity5/concept12/topic7/source7/case1` 与真盘一致；tree API 同数。拆机三段式（kill:port 43100→netstat 净）。坑记：ESM `dist/index.mjs` 直跑炸 cronstrue（包无 ESM 入口），dev.mjs 走 `dist/index.js` CJS 是对的。票 01 全项收口。
