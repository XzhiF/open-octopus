# 06: 策展写闸（审核队列联动 + curate skill + 写权保护）

**What to build:** 审核队列里 approve 一条待审知识（规则/词条修订）后，由策展人（archive 分身）编译通道执行合并/去重/断链校验并落 git commit + LOG 行；wiki 仓库对非策展通道的直接写入被 pre-commit 拒绝——"写入单一闸门"从流程约定变成技术强制。

**Blocked by:** 01（编译闭环）, 02（策展写入同样过 lint 闸）

**Status:** done

**Reference:** spec.md §架构决策 D4（写入单一闸门）· prototype.html Tab③「编译流水线」/Tab⑤ 审核队列 mockup

- [ ] 审核队列 approve（type: rule / wiki-edit，pending_review 既有表与 review 服务复用）→ 触发策展编译通道：合并近义规则、更新目标词条小节、断链校验 → git commit + LOG 行 + INDEX/FTS 同步
- [ ] 编译（compile）≠ 追加（append）：approve 后的写入必须经 02 lint 闸与合并逻辑，直接 appendFile 旁路不存在
- [ ] wiki repo pre-commit hook 拒绝非策展通道写入（hook 校验提交来源标记）；策展通道自身的提交带审核引用（pending item id）入 commit message
- [ ] octo-wiki-curate skill（写侧：编译流程/冲突检测/git 操作纪律）落 core-pack，仅 archive 分身绑定；消费侧分身不可见不可用
- [ ] user_preference.md 永不进入自动写路径（策展通道对它只有"AI 辅助编辑建议→人确认"形态，无自动改写）
- [ ] 冲突检测沿蓝图三型（contradicts/overlaps/supersedes）在编译时复核，supersedes 时旧规则迁 _retired/ 带 replaced_by 指针
- [ ] S1 缝测试：approve→编译→commit 环级（review.test + knowledge-loop.test 先例）；旁路写入被 hook 拒绝；preference 保护断言
- [ ] 可演示：队列 approve 一条规则 → 词条更新 + git commit + LOG 行三处一致

## Comments
- Merged to integration as e822004c (merge 4f0ab697 + merge-fix e822004c). server 3002/44 (baseline +12 curate/clone-tier, no wiki fails), web 987/6 baseline; curate 7 + clone-tier 5 + review 13 + cases 11 + cases-search 5 = 41/41 green simultaneously. Injection diff empty; octo-wiki-curate CLONE-tier-only confirmed (present in clones/archive/skills, absent from shared).
- 🔧 The merge-fix resolved a GENUINE semantic conflict: t06's `OCTOPUS_WIKI_COMMIT_SOURCE` pre-commit gate rejected t04's `compileCase` test fixtures (raw spawnSync pre-dating the gate) — 13 test fails — fixed by routing fixtures through `spawnGit(cwd)` (zero assertion/production change; revert-safe). Same interaction expected when ticket 05 merges.
- approveItem now async (wiki-edit→applyWikiCurate; rule/wiki-target/user_preference-target → curator compile gate before legacy append, P1 injection track intact). supersedes→`_retired/<anchor>.md` replaced_by, one atomic commit w/ `[review:id]`. compileEntry gained additive `reviewRef`. user_preference fail-closed 3 layers. Handoff: `C:\tmp\llm-wiki-notes\handoff-06.md`.
