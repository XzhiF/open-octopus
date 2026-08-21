# RESUME — task-authoring-v3 流水线恢复点

**状态**：spec 阶段已完成，issues/ 写到一半。任何新 session 读此文件 + spec.md 即可无损接续。

## 已完成

- ADR 0010/0011/0012（docs/adr/）+ CONTEXT-MAP.md 术语 5 条
- decisions/01-grilling-verification-strategy.md（验证策略门禁 resolved）
- brief.md · spec.md（含 Story Walk-Through 16 断点全部修复，D1-D19）
- story-walkthrough.md（独立走查报告）
- issues/ 01-04 已写：01 shared 类型 · 02 TaskHomeService · 03 PluginMaterializer · 04 创建扩展+skill-groups 路由

## 待写 tickets（计划已定，按此落盘即可）

| # | 标题 | Blocked by | 验证 |
|---|------|-----------|------|
| 05 | spec-field source 判别 + 确认持久化 + ready 门禁（D18/SW-BP4/BP5） | 01 | integration：source=user→notice；ready 409/200 |
| 06 | artifacts 路由：GET index + content 白名单（越权 403） | 04 | integration：内容==磁盘；损坏→[] |
| 07 | core-pack 辅助工作流 ×3 + AssistWorkflowService + routes（D16 临时 workspace / SW-BP10 parse 兜底） | 02 | integration：模板白名单 400；executions 按 task_id 可解析 |
| 08 | dispatch 注入 $vars.task_artifacts_dir（scheduler-service simple+composite+composition input_mapping，三断言） | 02 | integration |
| 09 | 前端两阶段流：TemplatePicker（组多选+语境）+ 顶栏🔒 + goal/ac 浮现/直编(source=user)/确认持久化 | 04,05 | E2E US1/3/4/5/6/14 + manual LLM 项 |
| 10 | 前端产出查看器：产物列表+全文弹窗 + 工作流记录+日志弹窗 + MoA 采纳面板 + 决策备忘 + SSE 刷新（D19） | 06,07,09 | E2E US7/10/11 UI |
| 11 | E2E 全链路 task-authoring-v3.spec.ts（扩展 task-domain-helpers，E2E_TD_ 前缀，screenshot 证据） | 09,10 | playwright run |

DAG stages: [01] → [02,05] → [03,07,08] → [04] → [06,09] → [10] → [11]

## 收尾动作

- 更新 `.scratch/index.md`（append：N | task-authoring-v3 | 2026-08-18 | feat/task-domain-redesign | in-progress）
- 告知用户下一步选项：matt-dev-pipeline（DAG 并发实现→review→deploy→E2E→PR）或 matt-pipeline-loop（带验证循环）

## 关键引用

- spec.md 的 Implementation Decisions 模块表 = 每 ticket 的改动文件清单
- spec.md 的 AC Mapping 表 = US↔验证方法
- 原型：packages/web-app/app/tasks/prototype/page.tsx 的 VariantL（前端 ticket 的交互参照，代码重写不复制）
