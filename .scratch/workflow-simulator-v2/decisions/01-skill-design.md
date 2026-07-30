# 01 — Skill 设计: 新 skill 还是扩展 octo-workflow-dev?

Type: grilling
Status: resolved
Blocked by: None

## Answer

**独立 skill `octo-workflow-test`**

Workspace clone 的 `skills: []` 自动继承所有全局技能。新 skill 放在 `packages/core-pack/skills/octo-workflow-test/` 即自动可用。

octo-workflow-dev §10 中添加一行引用: "测试: 使用 `octo-workflow-test` skill"。
