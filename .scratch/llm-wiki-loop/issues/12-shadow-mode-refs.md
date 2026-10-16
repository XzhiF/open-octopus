# 12: 影子双轨（knowledge.mode）+ wiki_refs 落盘 + 对照导出

**What to build:** 系统在"注入式仍在跑"的同时记录"Agent 查阅了什么"：knowledge.mode 配置（默认 both）保证注入链零改动；执行者写入的 wiki_refs 经 VarPool 落 JSONL/DB；影子对照导出按执行并排"注入了哪些规则 vs 实际查阅命中哪些"——P2 删除注入链（单向门）的决策数据从这里来。

**Blocked by:** 10（as: 身份装配）, 11（octo-wiki skill）

**Status:** done

**Reference:** spec.md §执行身份（影子双轨）/§Out of Scope（P2 前置）· prototype.html Tab⑦（P1 影子期与回滚开关）

- [ ] agent/分身配置增 knowledge.mode: inject | query | both，缺省 both；both = 注入链原样运行（**硬约束：既有注入相关测试一字不改全绿**）+ 查阅行为记录开启
- [ ] wiki_refs 通道：执行者经 vars_update 写入的 wiki_refs 落 VarPool 并随执行持久化（JSONL + DB 可查询）；stale 上报（wiki_refs 内 stale: 前缀条目）单独可筛
- [ ] mode=inject 时不记录 wiki_refs（关闭查阅语义），mode=query 时注入链不运行——两态可作 P2 预演与回退验证（回滚开关：mode 回 inject 即恢复现状）
- [ ] 影子对照导出（API 或命令）：按 executionId 并排注入侧（__relevant_rule_ids 等既有 VarPool 键，只读）与查阅侧（wiki_refs），输出命中/未命中/仅注入/仅查阅四象限
- [ ] GLOSSARY-MAP 入册「影子期 (Shadow Mode)」
- [ ] S2 缝测试：三态行为矩阵（inject/query/both 各自断言注入调用与 refs 记录的发生/不发生）、wiki_refs 持久化环级、导出形状（fixture 固化，禁止自证）
- [ ] 可演示：跑一条 both 模式执行 → 导出显示该执行的双轨对照行

## Comments
- Merged to integration as 565d52ab (merge of 98f91537/d1d6188d), clean descendant auto-merge. Engine 898/8, server 2970/44, shared model-alias-only fail, injection 37/37 — all baseline, no new genuine failures. knowledge-mode 12/12, three-state matrix + shadow-compare green.
- 🔴 RED LINE #1 held at blob level: 7 injection artifacts (prompt-injector.ts/knowledge-injector.ts/precompute.ts + 4 tests) byte-identical; mode wiring additive (executor-factory +5/-1, agent.ts +14/-5 hunks at old lines 1/35/50-52/541, injection BLOCK 398-421 unchanged). mode=query drops injector refs at ctor.
- Landed: `knowledge.mode` in `shared/types/agent.ts` CloneDef.config.knowledge + helpers `resolveKnowledgeMode/injectionEnabled/stripWikiRefs` (knowledge.ts); export `GET /api/workspaces/:id/executions/:executionId/shadow-compare` (routes/execution.ts→shadow-compare.ts, four quadrants hit/miss/injectOnly/queryOnly, stale filterable, read-only); wiki_refs via VarPool agent.ts:152. GLOSSARY 影子期. E2E (ticket 13) default mode=both exercises the dual-track export.
