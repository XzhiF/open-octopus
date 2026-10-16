# 05: 初始编译 · 程序化迁移（存量知识入库）

**What to build:** 一次性幂等迁移把存量知识资产编译进 wiki：org 知识目录的 projects/workflows 规则文件重排为 v2 词条（行内日期收编进 front-matter/LOG，锚点保留映射）、GLOSSARY-MAP 条目拆入 business/ 域、旧路径布局兼容读取一次——/wiki 页从"样例"变成"真实存量知识"，且全部过 lint 闸。

**Blocked by:** 01（编译闭环）, 02（迁移产物必须过 lint 闸）

**Status:** done

**Reference:** spec.md §服务端 API 与存储（初始编译）· prototype.html Tab③「初始编译」表 · 风险表（org 路径口径）

- [ ] 存量 org knowledge/{projects,workflows}/*.md → v2 词条：规则行内日期/来源注释收编（front-matter sources + LOG 首编译行），既有规则 id 映射为新锚点且不复用不冲突
- [ ] GLOSSARY-MAP 系统词条按域拆入 business/（拆分产物过 lint；超长自动走 02 的拆分提案）
- [ ] 旧知识目录路径（无 orgs/ 段的历史布局）兼容读取一次；迁移后旧目录只读保留（不删除，P2 后另议）
- [ ] 幂等：重跑迁移 git diff 为空、不产生重复词条/重复锚点
- [ ] 迁移产物 lint 全绿 + INDEX ≤800 token（超限自动触发拆分提案入审核队列，不静默截断）
- [ ] pipeline.yaml prompts 存量内容本期只登记清单不迁移（影子期人工分流的输入，登记产物落 .scratch 本 feature 目录）
- [ ] git 历史可审：初始编译为独立 commit 链（每域一 commit 或每源文件一 commit，LOG 对应）
- [ ] S1 缝测试：迁移幂等（跑两遍 diff 空）、锚点映射表断言、旧路径 fixture 兼容读
- [ ] 可演示：/wiki 页显示真实存量项目/工作流知识，词条 sources 可回指原文件

## Comments
- Merged to integration as 136f541f (merge ff4c4b38 + spawnGit fixture-fix 136f541f). server 3013/45 (44 pre-existing +1 deterministic load flake, zero wiki/migrate fails; delta = exactly 05's +12), web 987/6 baseline. 05's 12 tests + combined 41 green. Gate-fixture conflict (like t06) fixed fixture-only.
- Entry points: `POST /api/knowledge/wiki/migrate?org=` (routes/wiki-migrate.ts) + `packages/server/scripts/wiki-initial-compile.ts` CLI; all writes `await compileEntry` (async honored), zero gate bypass. Idempotency = sha256 per source in `_migration/state.json` + entry-on-disk (unchanged ⇒ skip ⇒ git diff empty). Anchor remap: legacy id → fresh never-reused `oct-NNN`, gap-free. Legacy no-`orgs/` path union-read once, old dir kept read-only (no deletion — red line 3).
- 🔑 REAL xzf-dev migration executed: 3 knowledge entries (oct-001…015) + 16 business chunks from GLOSSARY-MAP (123/123 terms) = 19 entries / 19 commits / INDEX 585 tokens / lint green / dev DB 19 rows + FTS. Fixed 2 real-format hazards (definition literal `<!--#oct-001-->` escaping; bare-pipe column truncation). Available for ticket 13 E2E.
- Pipeline-prompts inventory (`.../pipeline-prompts-inventory.md`): scanned 37 pipeline.yaml, ONLY 1 has `prompts:` (default/archive/test-loop-dev scaffold, empty global/targeted) ⇒ ZERO live prompt content ⇒ P2 injection removal has no pipeline.yaml carryover.
