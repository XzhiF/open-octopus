# 03: wiki 全局化搬家

**What to build:** wiki 全局唯一生效（D6①④）：xzf-dev 存量 wiki 连 git 史整体搬到全局知识根，服务端索引切全局键，全部读 API 返回全局库；user_preference.md 迁入知识根人工文件区。界面上从此没有任何 org 概念。

**Blocked by:** 01（Ops 前置）

**Reference:** spec §Implementation Decisions「已拍板的前置决策 D6」+「迁移与幂等」· prototype Tab⑥（存量迁移步骤 1-2）

**Status:** done

- [x] 搬家脚本幂等：xzf-dev wiki（含 .git）→ 全局知识根 wiki/；git log 历史连续可查（初始编译 commit 仍在）
- [x] DB re-key：wiki_articles org 列全部钉 'global' + FTS 重建，蓝绿迁移不丢行（迁移前后行数对账）
- [x] user_preference.md 迁知识根（人工文件区）；各 org 的 user_preference 原件进归档区
- [x] 旧 org wiki 路径兼容读一次（搬家窗口期），此后不再读；其余 org 的空 wiki 无迁移动作、不报错
- [x] tree / article / search API org 语义钉 'global'（参数容错保留，语义全局）
- [x] S1 测试：搬家幂等（重跑 diff 空）· git 史断言 · re-key 行数守恒 · 兼容读窗口行为

## Comments

**2026-10-13 实现（kc/03-global-move @758afcd3 → 并入集成分支 af799f1e）**

- 新 `wiki/global-move.ts`（WikiGlobalMigrator：dry-run/apply、三步有序）+ `routes/wiki-global-move.ts`；`global-paths.ts` 追加三符号（`resolveGlobalKnowledgeRoot`/`resolveGlobalWikiRoot`/`GLOBAL_WIKI_ORG`，全部委托票 02 的 `resolveKnowledgeRoot`——add/add 冲突就地按「票03 后续统一」落点解决）
- 改 `routes/wiki.ts`（tree/article/search 钉 global + 兼容读窗 `resolveWikiRootCompat`，全局根有内容后旧路径不再读——fixture 用「旧路径复活 ZOMBIE 标记仍不被读」实证）+ `wiki/paths.ts` + 既有 4 个 wiki 路由测试 seed 切 'global'
- 测试：S1 8 例 + S2 3 例全绿（真 git/tmpdir/内存 DB）；票 02 回归 27 例同绿；合并验证 baseline 对照零新增确定性红（archive-routes 预存 10 保持；wiki-cases 1 例为 Windows git 并行 flake，隔离 11/11 绿）
- **真数据 ops（主控执行，勿由代理跑）**：`POST /api/knowledge/wiki/global-move`（dry-run）→ `VACUUM INTO` 按 backupHint 备份默认库 → `?apply=true`（幂等可重跑，二次全 skip）。前提：不设 OCTOPUS_KNOWLEDGE_DIR/OCTOPUS_WIKI_DIR。**排期：写通道全局化（票 04/05/06）落定后统一执行**，re-key 前先停 3001 实例
- 范围注记（已入 global-move.ts 头注）：compile/curate/split 写通道仍按 org——收口属票 04+ 全局写队列；本票不删 org 数据（归档先于删除纪律由票 09 承接）

**真数据 ops 已执行（2026-10-13 主控，@kc-int 1fda3e4e 新代码挂默认库）**：dry-run 计划（xzf-dev 25 commits→move、12 空 org skip、re-key 19→19 零冲突、偏好三原件 archive+根 keep-existing-root）→ VACUUM INTO 备份 `octopus.db.pre-kc-ops.bak` → apply：全局根 wiki git log 25 连续、旧 org wiki 路径消失、DB `global|19` → 重跑全 skip ✓幂等。证据 `C:/tmp/kc-ops/gm-*.json`。
