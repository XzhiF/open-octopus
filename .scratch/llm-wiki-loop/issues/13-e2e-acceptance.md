# 13: E2E 验收票 — 闭环首跑（查阅→引用→可见）

**What to build:** 在 dev 实例上用真实 provider 完整跑通本期闭环：一条含 `as:`（或缺省 workflow-operator）的工作流执行，Agent 经 octo-wiki 导航协议真实查阅知识（JSONL 留痕）、以 wiki_refs 留下引用、/wiki 页可见被引词条、影子导出产出真实对照——P0+P1 全部机制在真环境串成一条可复验的证据链。

**Blocked by:** 01, 03, 04, 05, 06, 10, 11, 12

**Status:** done

**Reference:** spec.md §Testing Decisions（E2E 行）· matt-e2e-test-methodology（反假跑规范）· prototype.html Tab④（执行时间线 = 预期序列）

- [ ] dev 实例（隔离端口/独立 DB）准备：wiki 含真实存量词条（05 产物）+ 至少 1 个判例（04 产物）
- [ ] 真实 provider 跑一条含 agent 节点（显式 as: 或缺省 operator）的工作流，任务设计为必然触发查阅（如涉及项目构建规则的操作）
- [ ] 证据 1：执行 JSONL 出现 INDEX.md → 词条的 Read 工具调用序列（导航协议被真实遵循，非跳过 INDEX 的 glob）
- [ ] 证据 2：wiki_refs 落 VarPool/DB，引用的锚点 id 在词条中真实存在
- [ ] 证据 3：/wiki 页该词条可浏览，元数据面板 sources/git 近史非空
- [ ] 证据 4：影子对照导出含该 executionId 的真实对照行（注入侧与查阅侧并排）
- [ ] 回归：一条不含 as: 的既有工作流（如内置样例流）跑通无回归；octopus_agent 节点工作流回归一条
- [ ] 反假跑：E2E 报告附证据截取（JSONL 行/DB 行/页面状态），按 matt-e2e-test-methodology 规范落 e2e-report；脚本经 e2e-harness 模式可重跑

## Comments
- **PASS-WITH-CAVEATS** on dev instance @ integration eccbd6cb. Real provider confirmed non-mock (claude/sonnet via DashScope real endpoint, latency 5924 + real cache-token usage in JSONL). DB isolated via `VACUUM INTO` snapshot (default octopus.db read-only). Ports 3410/3411 (protected ports untouched), torn down + netstat-verified, worktree clean.
- Evidence 1 JSONL INDEX→entry→case Read sequence (non-glob) ✓ · Evidence 2 wiki_refs→executions.var_pool, anchors oct-008/014 verified against entry text ✓ · Evidence 3 article/tree/search with sources+gitHistory, /wiki 200 ✓ · Evidence 4 shadow-compare four quadrants real (relevant=15, injected=[] expected, queryOnly carries refs) ✓ · regressions (a) no-`as:` (b) octopus_agent task-doer delegation ✓. Case `case-e2e13-001` inducted via SOLE write gate `compileEntry` (wiki-repo commit dcec486, INDEX/LOG/FTS/DB synced) — no HTTP case endpoint this phase (P3). Rerun script `C:\tmp\llm-wiki-notes\e2e13\e2e13-rerun.mjs` 9/9. Report `.scratch/llm-wiki-loop/e2e-report.md`; story→evidence map inside.
- 🔴 2 defects found, TO FIX in review stage:
  - **D1** `core-pack/skills/octo-wiki/SKILL.md:29` example is YAML-line form; `parse-vars-update.ts:8-12` only parses JSON → agents copying the example SILENTLY lose wiki_refs (exec 2 reproduced; exec 4 fixed→refs land). Fix = rewrite example to single-line JSON `{"vars_update":{"wiki_refs":[...]}}`, sync repo core-pack + `.claude/skills` mirror + rebuild (provision source `~/.octopus/resources/installed/skills/built-in/` refreshes from build). Recommend add `applyVarsUpdate` warn on unparsed wiki_refs block.
  - **D2** a node with no `skills:` declaration doesn't materialize octo-wiki into `.claude/skills` (identity `snapshot.skills` only goes to SDK whitelist `identity-assembly.ts:66-70`; provisioning reads YAML decls `engine-init.ts:325-379`+`resource-preflight.ts:108-115`). Weakens story 22 "零改动获得知识查阅能力" + handoff-12/11 overstatement. **Ruling: Option A** — merge resolved identity `snapshot.skills` into the EngineInitPhase provisioning analyze set so default-operator nodes auto-provision octo-wiki; then re-verify D2 via E2E (default node, no explicit skills → octo-wiki materialized + refs land).
- [ ] 产出 verification-report 素材：本期 spec 故事簇 → 证据映射表（供后续 matt-verification-report 消费）
