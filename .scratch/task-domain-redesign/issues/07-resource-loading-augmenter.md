# 07 — server: 资源加载 augmenter + requires 传播（SPIKE S2 gated）

## What to build
SG11 新 `TaskAuthorSessionAugmenter`：`ResourceManager`→解析 installPath→读 SKILL.md→`enhancePromptWithSkills`（救活死码）→pi-sdk systemPrompt。SG6 每 turn clone chat 路由开头重读 `tasks.authoring_resources[]`→`_rebuildSystemPrompt`（pi-sdk-adapter.ts:106）（**SPIKE S2 验证**；不可行→备选每 turn 重建 session / user-msg preamble）。SG7 `materializeTaskSpecToConfig` 传播 `tasks.resources[]`/`subunit.resources[]`→`config.requires`；`EngineInitPhase` UNION 合并 `config.requires`→`workflow.requires`。draft 期 prompt-inject；workspace 期 provisioner。

## Blocked by
03 (tasks service), 06 (materialize), 13 (pi-sdk resume — 同文件 pi-sdk-adapter.ts 安全序), 05 (reverse-msg — clone-runtime.ts 同文件序)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: authoring_resources[]→task-author session prompt 含 SKILL.md 内容（draft 期）
- [ ] AC2: task-author 每 turn fresh session（`providerSessionId=null`）+ `assembleContext` 注 authoring_resources SKILL.md + DB 历史 prepend（SPIKE S2 Mechanism B）
- [ ] AC3: tasks.resources[]/subunit.resources[]→config.requires→workflow.requires UNION；EngineInitPhase 分发

## Verification Method
**integration**: tasks.authoring_resources=[{skill:X}]→task-author session system prompt 含 X 的 SKILL.md；materialize 后 config.requires 含资源；workspace 执行时 .claude/skills/ 有资源。Pass: 注入+传播+分发。
**SPIKE S2 — RESOLVED**：Mechanism B（task-author fresh session per turn + assembleContext 注入 + DB 历史 preamble）；不改 v2-D8。Latent bug（Pi SDK resume 路径 broken，findSession 返 SessionManager）pre-existing，task-author 绕开，out of v2 scope（建议另起 ticket 修）。
