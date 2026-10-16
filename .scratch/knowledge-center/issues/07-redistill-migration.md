# 07: 重蒸馏迁移 — 22 条 v2 词条 → v3 五类页

**What to build:** 存量知识资产换代不丢不断：现有 v2 词条（规则容器形态）经策展人重蒸馏为 v3 五类页；规则行迁入 topic 页「硬约束」小节且**锚点原号随迁**（历史 wiki_refs 引用不断链）；旧页整迁 _retired/v2/；全程单 commit 可整体回滚、脚本幂等。

**Blocked by:** 03（全局化搬家）, 04（v3 基座）, 05（编译管线）

**Reference:** spec §Implementation Decisions「迁移与幂等」重蒸馏映射 · prototype Tab⑥（存量迁移步骤 3-4）

**Status:** done

- [x] 映射执行：projects/workflows 词条 → topic 页（规则行进「硬约束」小节，锚点原号随迁）；business → concept 页；research → concept/source 页；cases 原样保留；Glossary 蒸馏产物归并进对应 concept/entity 页
- [x] 旧页整迁 `_retired/v2/`（不删除）；重蒸馏 = 单 commit（整体 revert 可还原）；脚本幂等（重跑 diff 空）
- [x] 旧引用兼容：v2 形态 wiki_refs（旧词条id#锚点）在新库可解析——锚点随迁对照表落盘并断言
- [x] LOG 旧表格行机械转换为行格式（原表格封 git 史）；INDEX 重建为五类分组
- [x] DB type 值切五类 + FTS 重建（行数对账不丢）
- [x] S1 测试：幂等 / 锚点随迁对照 / 断链零 / _retired 完整性 / LOG 转换可逆性（git 史可查原表）

## Comments

**2026-10-13 实现（kc/07-redistill @7a368b2c → 并入集成分支 f10766ee，零冲突；+1652/−2）**

- `wiki/redistill.ts`（WikiRedistillMigrator 单入口 dry-run/apply，形制同票03）+ `routes/wiki-redistill.ts`（apply 经 `enqueue("redistill")` 全局写队列，fb5b745c/61f46dbf 兑现票 06 接队）+ paths.ts REDISTILL_MAP_REL 台账单源 + compile.ts nextRuleAnchor 读剥落锚点台账（永不复用延伸）
- 映射决策表：projects/workflows→topics（id 保号、规则行入「硬约束」、锚点原号物理随迁）；business-Glossary 分片按 pkg 归并 concepts（容量超页 `-p2` 续页）；business-非Glossary/research→concept 1:1 保号（不伪造 source 页——回执页是票05 raw 管线产物）；cases 文件不动、DB type 值切 'case'；非 topic 页锚点注释剥落入 `_retired/v2/redistill-map.json` 台账（carried=false，可解析性由台账断言——v3 锚点小节铁律与「原号随迁」的折中，裁定认可）
- 六组断言：幂等（重跑 already-redistilled+tree hash 不变）/ 锚点对照+无双花+跳号发号 / 断链零+旧链接改写 / _retired 逐字节完整（git show -M 全 R）/ LOG 转换可逆（git show^ 查回原表+revert 全还原）/ DB 守恒五类+归并台账硬拒+FTS 重建
- 测试：S1 9 + S2 3 全绿；并入后回归 2232/28红=基线逐名一致零新增（leaderboard 单跑转绿）；CURATOR_LEGACY 拒消解对照在测
- 真语料只读干跑预期（真仓零改动实证）：19→11 页（topics×3+concepts×8）、retired 19、锚点 143（随迁 20/台账 123）、LOG 25 行转、DB 20→12 行
- **真数据 ops（主控，序=票03 搬家后）**：`POST /api/knowledge/wiki/redistill`（dry-run）→ VACUUM INTO 备份 → `?apply=true` → 重跑验 already-redistilled；回滚 `git revert <commit>`（wiki 仓）+ DB 备份还原
- 遗留注记：hub 子目录形态硬拒交人工（真语料无）；DB 面不入 git commit（同票03 纪律）

**Review P4 口径转正（2026-10-13，只读取证）**：spec 故事 34「22 条 v2 词条」为口径误——真数据核=盘上词条 .md 19 与默认库 wiki_articles 19 行逐一对合（16 business+2 projects+1 workflows）；全量 .md 22=19 词条+判例 1+INDEX/LOG 2 导航件。**票 07「19→11 页」正确**，无 DB-only 幽灵行。

**真数据 ops 已执行（2026-10-13 主控）**：首跑暴露两缺陷（DB 漏判例行 REDISTILL_DB_VERIFY_FAILED / 闸后失败污染 fs）——现场冻结复位后由 kc/redistill-fix 修复（67c14ed3→并入 1fda3e4e，现场复刻 fixture 四条件+先红后绿）。新 build 幂等补跑：`reason=already-redistilled`、fs 零动作零新 commit、DB 补入 case-e2e13-001、verify 12=12（8 concept+3 topic+1 case，fts=12）。终态：HEAD 492c67d/26 commits、_retired/v2 19、LOG 26 行 v3、INDEX 五类。证据 `C:/tmp/kc-ops/rs-*.json`。
