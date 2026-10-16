# 07: 初始编译 · 蒸馏迁移（research/ADR → 审核队列）

**What to build:** docs/research（约 20 篇调研）与 docs/adr（28 篇决策）经 LLM 蒸馏为候选词条（research/ 与 business/ 域，保留原文指针），进审核队列等人审，采纳后经策展写闸编译上线——调研与决策资产从"人肉阅读"变成 Agent 可导航的蒸馏结论，原文留档不动。

**Blocked by:** 02（蒸馏产物过 lint 闸）, 06（采纳走策展写闸）

**Status:** done

**Reference:** spec.md §初始编译（蒸馏行）· prototype.html Tab③「初始编译」表 · docs/research/knowledge-system/（本身也是蒸馏对象之一）

- [ ] 蒸馏命令：docs/research/* → research/ 域候选词条（结论+决策依据+来源指针三段式）；docs/adr/* → business/（或 research/）决策词条（决策+理由+指针）；原文正文零改动
- [ ] 蒸馏产物 sources 带 doc: 指针（可回跳原文）；每篇原文对应候选可追溯
- [ ] 候选批量入审核队列（pending_review，source 标记蒸馏迁移），人审采纳后经 06 通道编译；拒绝项留档不写入
- [ ] 幂等：重跑蒸馏不重复入队（按源文件指纹去重标记）
- [ ] 蒸馏质量控制：结论段禁复制原文长段（>20 行代码块/大段摘抄被 lint L5 拦下即返工）
- [ ] S1 缝测试：蒸馏产物 schema 合规、幂等标记、队列条目形状（LLM 调用用 fixture 固化，测试不打真模型）
- [ ] 可演示：审核队列出现蒸馏候选 → 采纳一篇 → /wiki research/ 域可见且指针回跳原文

## Comments
- Merged to integration as eccbd6cb (merge of 268be6f8, clean ff-descendant). server 3026/44 baseline (all 8 fails pre-existing env, 0 wiki), wiki-named tests 110/110 green incl +12 distill; web 987/6 baseline. Injection chain zero diff; docs/ byte-unchanged.
- Entry: `POST /api/knowledge/wiki/distill?org=&docsPath=` (routes/wiki-distill.ts) + `WikiDistillService` (services/knowledge/wiki/distill.ts). LLM seam = ctor `DistillSummarizer` (RuleFormJudge 同法), prod adapter `createLLMDistillSummarizer(callHaiku)`, tests fixture-mock — zero real model in tests.
- 🔑 Enqueues ONLY (sole persistence `PendingReviewDAO.insert`, zero直接写盘): type=wiki-edit, source=distill-migration, scope=wiki; adoption via ticket-06 `approveItem → applyWikiCreate → compileEntry` (no appendFile bypass). Idempotent dedup by sha256 fingerprint in row id + source_ref. research→res-* 结论/决策依据/来源指针; adr→biz-adr-* 决策/理由/来源指针; sources carry doc:<path> 回跳.
- All 12 code tickets (01–12) now on integration. Remaining: ticket 13 E2E (runtime acceptance), then final /code-review + /pr.
