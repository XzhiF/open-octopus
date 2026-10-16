# 08: Prefactor — IdentityResolver 抽取（行为零变化）

**What to build:** 把 octopus_agent 执行器内部的"执行身份快照解析"（agent_versions 已发布快照优先 → built-in/clones 目录兜底）抽成引擎内共享的 IdentityResolver，octopus_agent 换用它——为票 10 的 `as:` 通用装配铺路。本票是纯重构：make the change easy, then make the easy change。

**Blocked by:** None (can start immediately)

**Status:** done

**Reference:** spec.md §执行身份（P1）· ADR-0005/0006（装配语义约束）· 既有 octopus-agent 测试是行为基线

- [ ] IdentityResolver 抽出：输入分身英文代号（可选 @版本），输出身份快照（persona/config/skills）；解析序 = agent_versions 已发布快照 → built-in 目录 → clones 目录 → 皆无则可读错误
- [ ] octopus_agent 执行器换用 IdentityResolver，**行为零变化**：既有 octopus-agent 相关测试不改断言全绿（允许的改动仅限调用点/import 适配）
- [ ] Resolver 单测：快照命中 / 无发布版本回退目录 / 目录也没有时错误信息含候选路径；版本钉住（@N）解析
- [ ] 不新增任何面向 YAML 的字段或语义（`as:` 属票 10）；不触碰注入链（PromptInjector/KnowledgeInjector 零改动）
- [ ] 装配输出形状与现有 AgentExecutor 入参对齐（systemPrompt / skills 白名单），票 10 可零适配接入
- [ ] 可验证：engine 测试套件全绿 + resolver 新单测绿

## Comments
- Merged to integration as a1b3dd6e (merge of dc078eeb). Engine suite 855/8/2 at baseline (8 pre-existing machine-bound failures unchanged, file-by-file verified); 6 new identity-resolver tests green; behavior zero-change confirmed (octopus-agent parse/task-prompt/heartbeat unchanged).
- For ticket 10: `IdentityResolver` exported from engine index; `resolve(ref,{versionSpec?,minStage?})` returns ResolvedVersion (persona→systemPrompt, skills→whitelist); ⚠️ `versionResolver` currently required in deps — make optional for CLI fs-only parity. Handoff: `C:\tmp\llm-wiki-notes\handoff-08.md`.
