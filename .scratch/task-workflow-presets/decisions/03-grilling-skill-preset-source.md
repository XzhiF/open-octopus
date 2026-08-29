# 03 — 技能组预设工作流的来源

Type: grilling
Status: claimed
Blocked by: 02(resolved)

## Question

"按技能组预设的 workflows" 放哪、怎么推导,agent 枚举时如何过滤到"与本任务 skill_groups 相关"?候选:
- A. workflow YAML 声明 `skills: [group-a]` 反向索引(每个流程声明适合哪些 skill 组)。
- B. skill 资源里声明 `workflows: [ref]` 正向索引。
- C. 约定式:内置按 `built-in/` 前缀,技能组另有目录约定。
- D. org catalog 映射文件。

需同时满足:agent 推荐有据(param 传入 skill_groups → 返回过滤清单)、可扩展、默认(未打标)可兜底。

## Answer

**SUPERSEDED(2026-08-27,用户推翻):** workflow YAML 声明 skills / 改 schema 均否决。技能"组"概念模糊,workflow 作者不该维护"组→流程"归属。改为**独立映射层 preset catalog**(见 09 票):catalog 一条预设 = 一组 skills + 一个 workflow ref(+ category 语义 + 可选输入骨架),agent/UI 按 skills 过滤出 preset 得到候选。workflow 自身零改动。