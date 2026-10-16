# 02: wiki lint 编译期闸 + 拆分提案

**What to build:** 维护者构造一个超容量/断链/带日期的词条尝试编译，被 lint 硬闸阻塞并自动收到一份按 H2 小节的拆分提案（进审核队列）；采纳提案后词条按"文件长大成目录"拆为 hub + 子词条，规则锚点跟随迁移不断链——知识库从此有制度化的抗膨胀能力，不靠自觉。

**Blocked by:** 01（wiki 编译 tracer-bullet）

**Status:** done

**Reference:** spec.md §增长约束（L1-L6 阈值表）· prototype.html Tab③「增长约束」节（阈值来自原型）

- [ ] L1 词条容量闸：≤120 行 / 25 条规则 / ~2000 token（先到为准）→ error 拒写，并自动生成按 H2 小节的拆分提案入审核队列（pending_review 既有表/服务复用）
- [ ] L2 拆分执行：提案采纳后落 hub 目录形态（hub README ≤40 行，仅子词条一行摘要+指针）；规则 id 锚点跟随规则迁移，全库引用（[[wikilink]]/案例 rule_ref）改写不断链；git 层面体现为 mv + 编译 commit
- [ ] L3 单 H2 小节 ≤10 条规则 → warn（提示应独立成子词条，不阻塞）
- [ ] L4 INDEX.md ≤800 token → error；超限时低频词条自动移入 Optional 节或触发 hub 化提案
- [ ] L5 完整性：schema/锚点唯一/断链（[[wikilink]] 目标存在性）/正文禁日期/禁 >20 行代码块；断链可被 INDEX 程序化重建自动修复的部分不打扰人
- [ ] L6 规则形态：祈使句/事实陈述判定（编译时 LLM，warn 级 + 附改写稿，描述句给祈使化建议）
- [ ] lint 在编译服务写路径入口同步执行——任何写入通道（含 06 的策展通道）都过闸，无旁路
- [ ] S1 缝测试：每级规则一个构造 fixture（超限/断链/日期/长代码块/描述句），断言 error 阻塞产物、warn 提示产物、拆分提案形状；导航深度断言（INDEX→hub→子词条 ≤3 跳）
- [ ] 可演示：编译超限样例被拒 + 队列出现提案；采纳后目录形态与锚点完整性可验证

## Comments
- Merged to integration as fbd8b78f (merge of d0db761c/12d84f55), clean file-disjoint auto-merge with ticket 03. Combined wiki tests 32/32 green (lint 22 + search/meta 10 simultaneously); server 2955/45 (45th proven a load flake, isolated = baseline 44); injection chain zero-diff.
- Lint module `wiki/lint.ts:lintWikiEntry` L1-L6; cases-exemption seam `lintProfileForDomain` (cases→capacity:false,datesInBody:false, auto-applied via meta.domain) FOR TICKET 04. L6 `RuleFormJudge` ctor-injected, fixture-mocked.
- 🔴 `compileEntry` now ASYNC (Promise<CompileResult>) + ctor `{rootDir?, ruleFormJudge?}` — tickets 05/06/07 MUST await. Split proposals → `pending_review` type=`wiki-split` (id `wiki-split-{org}-{entryId}`), `countPendingByType` wiki bucket; adoption `ReviewService.approveItem`→`WikiSplitService.applyProposal` (split.ts, git mv/anchors-follow/wikilink rewrite/re-lint). Handoff: `C:\tmp\llm-wiki-notes\handoff-02.md`.
