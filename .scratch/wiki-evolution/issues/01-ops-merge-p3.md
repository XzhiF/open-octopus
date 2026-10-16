# 01: Ops 前置 — P3 合入 main + 对账复核

**What to build:** P3 分支作为干净基线进入 main：PR（附 P3 e2e-report 与 DEFER 单）→ 合入 → 跑既有对账脚本复核默认库索引与真盘一致。P4 全部票从此基线长出。

**Blocked by:** None (can start immediately)

**Reference:** spec §Implementation Decisions「前置」· `.scratch/archive-assets/issues/09-e2e-acceptance.md` Comments（D-aa16-2/3 由本 phase 票 03/04 承接）

**Status:** done

- [x] PR 开出并合入 main（body 挂 P3 e2e-report + D-aa16-2/3 DEFER 单去向说明：03/04 承接）
- [x] 合入后跑对账脚本：默认库 wiki_articles/FTS 与真盘页数一致（含 P3 E2E 沉淀）
- [x] 生产实例抽查：/knowledge 树与健康条数字真实
- [x] P4 工作分支从合入后的 main 开出；PR 链接与对账结果回报票 Comments
- [x] 保护端口 3000/3001/3098/3099 不碰；拆机三段式

## Comments

**2026-10-15 主控 ops 执行（一次收口全绿）**

1. **PR 合入**：#76（`feat-archive-assets-20261014` → main）body 已按票面更新 DEFER 去向——D-aa16-2 → 票03、D-aa16-3 → 票04（`.scratch/wiki-evolution/spec.md`）。分支 27 ahead / 0 behind，本地 `git merge --ff-only` + push，GitHub 自动识别 MERGED（同 #75 ff 先例）。PR 链接：https://github.com/XzhiF/open-octopus/pull/76 。main tip = `eca3b4ce`。
2. **对账复核**：备份 `octopus.db.bak-pre-p4-reconcile-20261015`（sqlite3 VACUUM INTO）→ `wiki-reconcile --db 默认库`：盘 36 页（entity=6 concept=17 topic=4 source=4 case=5），before 20 行，inserted 16（含 P3 E2E 沉淀 case×4、con-material-package、src-aa16-selffix-probe2 等）+ updated 2，**VERIFY OK 36==36，fts 36**；复跑 **diff 空（幂等）**。
3. **生产实例抽查**：`pnpm dev --port` 落 isolated 分支库（pages=0 不符）→ 改直起 `PORT=3420 OCTOPUS_DB_PATH=默认库 node dist/index.js`：`/api/knowledge/health` **total=36 各类目与对账真值逐项吻合**、gitHead=000239b（真知识根）；`/api/knowledge/wiki/tree` 六域实体为真（ent-karpathy/obsidian/qmd 等 P3 沉淀在列）。拆机三段式：kill:port 3420 → netstat 无监听 → 误建空库 `octopus-main.db*` 已删、临时日志清。
4. **P4 集成分支**：`feat-wiki-evolution-20261015` 自 eca3b4ce 开出并推远端（跟踪已建）。

