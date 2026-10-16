# 11: octo-wiki skill + Provisioner 预置 + 分身绑定

**What to build:** Agent 获得知识查阅能力本体：octo-wiki skill（导航协议/检索兜底/引用纪律/禁止事项）落 core-pack，经 ResourceProvisioner 预置进执行 workspace 被 SDK 原生发现（ADR-0006，不走 prompt 注入）；task-author/task-doer 绑定该 skill，task-doer 任务上下文增加一行恒定指针（指路不喂饭）。

**Blocked by:** None (can start immediately)

**Status:** done

**Reference:** spec.md §执行身份（octo-wiki skill/指针行）· prototype.html Tab④（SKILL.md 骨架全文，来自原型）· ADR-0005/0006/0013

- [ ] octo-wiki skill 落 core-pack，四段齐备（原型骨架）：何时查（动手前四域 + 卡壳按症状查 cases）、导航协议（INDEX → 整读词条 → search API 兜底，禁全库遍历）、引用纪律（wiki_refs 经 vars_update / 产出标注 [ref: 锚点id] / stale 上报不沉默）、禁止事项（禁写 wiki 目录 / 禁整篇粘贴进交付物 / 禁跳过 INDEX glob）
- [ ] skill 内路径约定与 wiki 根实际布局一致（orgs/ 路径口径），search API 端点形状与票 03 契约一致
- [ ] ResourceProvisioner 预置链路：执行前 octo-wiki 出现在 workspace .claude/skills/（resource-preflight 既有测试扩展）；SDK settingSources 原生发现，无任何 prompt 文本注入技能的实现（ADR-0006 红线）
- [ ] task-author / task-doer 分身声明绑定 octo-wiki（config skills 声明，治理语义）；archive 分身在票 06 已绑 curate，此票补 octo-wiki（读侧）
- [ ] task-doer 任务上下文（每轮 buildTaskContext）增加一行恒定指针：wiki 根路径 + 查阅纪律提醒；**断言该行不含任何知识正文**且长度 ~50 token 级（指针 ≠ 注入的边界，spec D2 裁决）
- [ ] 注入链零改动：本票不触碰 PromptInjector/KnowledgeInjector/precompute
- [ ] 测试：preflight 预置产物断言、doer 上下文指针行断言（task-doer-service 既有测试先例）、skill 文件结构合规（front-matter/段完整性静态检查）
- [ ] 可演示：执行预检后 workspace 内 skill 可被 SDK 列出；doer 轮次上下文含指针行

## Comments
- Merged to integration as 04c3af0e (merge of 71fb86e4/2c3eb9fd). Build+sync skills=24; server 2931/44 vs 2925/44 baseline (zero new failures, +6 = ticket-11 tests); GLOSSARY auto-merged (Entry + INDEX/LOG + 内置分身8 + 导航协议 all present); injection chain zero diff.
- octo-wiki landed in core-pack SHARED tier (`packages/core-pack/skills/octo-wiki/SKILL.md`, four sections verbatim Tab④) — red-line test asserts it never in clone-tier. Zero provisioner production-code change needed: existing `registerBuiltins()` scan + `ResourceProvisioner.provision` + `provider.ts:343 settingSources` already give SDK-native discovery (ADR-0006). Preflight test +3 assertions.
- Clone bindings (governance): archive/task-author/task-doer get octo-wiki; workflow-operator stays `['octo-wiki']`. task-doer `buildTaskContext` one constant pointer line at `task-doer-service.ts:411` (≤200 chars, zero knowledge body, pinned by chat test).
- Downstream: ticket 12 keys wiki_refs off the pointer-line `wiki_refs`/`[ref:]` tokens; ticket 06 curate goes CLONE-tier (opposite of octo-wiki). Handoff: `C:\tmp\llm-wiki-notes\handoff-11.md`.
