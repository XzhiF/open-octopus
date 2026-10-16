# 04: cases/ 判例域

**What to build:** 一次历史问题（如"CI 报 lockfile 失配"）以判例形式结构化入库（症状/标签/次数/规则指针 + 现场/诊断/根因/修复/教训五段），agent 或人卡壳时按症状检索命中判例、沿 rule_ref 顺藤读到规则——"上次这个症状是怎么回事"有了可检索的判例库。

**Blocked by:** 01（编译闭环）, 03（检索 API 与 UI 渲染面）

**Status:** done

**Reference:** spec.md §知识表示（案例文件 schema，来自原型）· prototype.html Tab③ cases 节（CBR 依据）

- [ ] 案例 schema 落地并过校验：front-matter（id/symptom/tags/severity/occurrences/rule_ref/source/status: open|distilled|superseded）+ 正文五段（现场/诊断/根因/修复/教训）；文件名 {日期}-{slug}（案例是历史记录，日期正当）
- [ ] 准入宽松且与规则不同：只校验真实 + source 可定位（task/exec/commit 指针），豁免半衰期三问；lint 对 cases 域豁免 L1 容量闸与正文禁日期规则（历史叙事事件事件绑定）
- [ ] append-only 语义：入库后正文不改写，仅 status/rule_ref/occurrences 三个字段可经编译通道更新；改写尝试被拒并留 LOG
- [ ] search API domain=cases 时 symptom/tags 加权命中；命中结果带 rule_ref 指针（顺藤读规则）
- [ ] INDEX.md 含 cases 节（每案例一行：症状摘要+tags+蒸馏状态）
- [ ] /wiki 域树含 Cases 组，案例详情五段渲染 + 状态 chips（open/distilled/superseded）
- [ ] S1+S3 缝测试：schema 校验、append-only 拒改、症状加权检索命中、INDEX 节生成
- [ ] 可演示：样例判例入库 → 按症状检索命中 → UI 五段渲染 → rule_ref 跳转词条

## Comments
- Merged to integration as 786fd441 (merge of c0e2cbdf/3eaedaf2). server 2990/44 (baseline, +20 wiki tests green), web 987/6 (baseline), lint 0 errors; KnowledgeTab zero diff; NO .scratch/decision-brief files (cwd-drift accident fully reverted, main verified clean at 82d96372).
- Schema `WikiCaseFrontmatterSchema` (shared/types/wiki.ts: id/symptom/tags/severity/occurrences/rule_ref/source + status open|distilled|superseded) + 5-section body + `{date}-{slug}.md` + `LOCATABLE_SOURCE_RE`; DB untouched (v52). Append-only via `compileCase` (LOG `case-rej` then throw `CASE_APPEND_ONLY`; only status/rule_ref/occurrences updatable). Reused ticket-02 `lintProfileForDomain("cases")` (L1+dates exempt, L5 links still gated). Search `caseWeightScore` symptom×4/tags×3/body×1 + ruleRef. /wiki Cases group data-driven via ticket-03 tree + status chips + `wiki-rule-ref` 顺藤 jump.
- Handoff: `C:\tmp\llm-wiki-notes\handoff-04.md`. E2E (13): cases flow through curate compile channel (ticket 06) and search `domain=cases` (ticket 03).
