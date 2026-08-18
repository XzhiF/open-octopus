# 01 — 验证策略（Grilling 路径强制门禁）

Type: grilling
Status: resolved

## Question

Task Authoring v3 的 6 个验证维度如何定？

## Answer

### 1. 验证级别
- **Unit (vitest)**: TaskHomeService（家目录创建/reap/artifacts.json 读写）、PluginMaterializer（symlink/junction/copy 降级）
- **Integration (vitest + 真 DB)**: skill-groups 路由、tasks 创建扩展、artifacts 路由、assist-workflow 触发/查询路由。沿用 `tasks-routes.test.ts` / `07-authoring-inject.test.ts` 模式
- **Browser E2E (Playwright)**: 扩展 `e2e/helpers/task-domain-helpers.ts`（已有 SSE collector / SQLite 直读 / E2E_TD_ 前缀），新增 task-authoring-v3 spec
- **Manual checklist**: LLM 对话行为（agent 主动绑定 goal/ac、agent 建议触发辅助工作流）——非确定性内容不进自动断言

### 2. 中间件连接
- SQLite `tasks` 表：task_spec JSON 中 task_type/skill_groups 字段断言
- 文件系统 `~/.octopus/tasks/{id}/`：skills/ symlink + artifacts/artifacts.json 断言
- workflow_executions 表：辅助工作流 run 状态断言

### 3. 设计规范
无 Figma。设计参照 = 原型 Variant L（`packages/web-app/app/tasks/prototype/page.tsx` 的 VariantL 函数，`?variant=L`）。保真度：交互结构 1:1，视觉 rough alignment。

### 4. 测试数据
- 前缀 `E2E_TD_`（沿用 task-domain 约定）
- 测试 Skill 组：通过 resource API 安装测试组（resource-helpers.ts 已有 installResourceViaApi）
- 清理：DELETE task + 家目录 reap 断言

### 5. 断言方式
- API↔DB↔文件系统三方交叉（R3）：创建任务 → GET 响应 + SELECT task_spec + readdir 家目录
- SSE：spec_field_update 事件收集（已有 collector）
- 产物内容：GET content 端点返回 == 磁盘文件内容
- UI：goal/ac 浮现、锁定 badge、产物弹窗内容可见（Playwright locator + screenshot 证据）

### 6. 前提条件
- `pnpm build` + `pnpm dev`（server :3001 / web :3000）
- registry 至少一个已安装 skill 资源组（E2E 自行安装测试组）
- LLM provider 可用（chat 相关 manual checklist 项）
