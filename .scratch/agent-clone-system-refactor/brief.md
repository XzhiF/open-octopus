# Requirement Brief

## Overview

重构 Agent 模块：建立 4 个内置分身（Workspace / Scheduler / Archive / Resource）的统一体系，消除散落的聊天实现和硬编码编排逻辑，采用业内验证的双路径架构（Main Agent tool-calling + 页面直连分身）。

## Projects Involved

- [x] `@octopus/server` — 后端核心：CloneRuntime、分身路由、Session 统一、上下文组装
- [x] `@octopus/shared` — 类型定义：CloneDef、CloneSession、CloneContext 等共享类型
- [x] `@octopus/providers` — Provider 统一调用封装（resume + append）
- [ ] `@octopus/web-app` — 前端：API 路径切换，渲染逻辑不变
- [ ] `@octopus/cli` — CLI：统一入口 `octopus agent chat` 走 Main Agent
- [ ] `@octopus/engine` — 不变（Swarm 执行器保持现状）

## Feature Scope

**Do:**
- 定义 4 个内置分身（workspace, scheduler, archive, resource），各有独立 persona + 专属 skills
- 建立 CloneRuntime 基础设施层（上下文组装、Provider 调用封装、错误恢复）
- 统一 Session 体系：扩展 AgentSessionDAO 的 MessageRow（加 type + metadata + provider_session_id）
- 统一 Provider 调用：所有分身走 Claude Code SDK + resume + append 分身上下文
- 双路径 API：统一入口（Main Agent tool-calling 委托分身）+ 直接入口（页面直连分身）
- 文件系统布局：`~/.octopus/agent/built-in/{name}/` (内置) + `clones/{name}/` (用户)
- 共享策略：记忆读共享/写隔离 + 技能叠加 + 人格替换
- 拆解 OrchestratorService：意图分类/工作流选择删除，工具方法分散到分身
- 前端三个聊天入口的显示/功能保持一致（API 路径可变更）

**Don't:**
- 不改 Swarm 执行器（engine 包保持不变）
- 不改 Workflow Engine 核心
- 不加新的前端 UI 功能（只改 API 路径）
- 不做数据迁移（用户确认不需要）
- 不改 core-pack 资源（skills/agents/workflows 定义不变）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Clone 本质 | 拥有独立记忆/技能/人格的 Agent 实例 | 用户明确：不是角色换皮 |
| D2 | 内置分身数量 | 4 个：workspace / scheduler / archive / resource | 覆盖系统核心场景 |
| D3 | 分身边界 | workspace=全能助手, scheduler=定时管家, archive=归档+知识库, resource=资源管理 | 职责清晰，无重叠 |
| D4 | 架构模式 | 双路径：Main Agent tool-calling + 页面直连 | CLI 统一入口 + Web 零延迟直连 |
| D5 | Session 统一 | AgentSession 体系 + 扩展 MessageRow | AgentSession 已有分身基因，扩展成本最低 |
| D6 | Provider 统一 | 全部 Claude Code SDK + resume + append | 两套聊天都已用 SDK，统一后全分身支持 resume 省 token |
| D7 | OrchestratorService | 拆解消除 | 意图分类被 LLM 取代，工具方法归分身 |
| D8 | 上下文组装 | 记忆读共享/写隔离 + 技能叠加 + 人格替换 | 分身能利用全局知识，但写入隔离 |
| D9 | 文件系统 | built-in/{name}/ + clones/{name}/ | 内置与用户分身物理隔离 |
| D10 | 前端一致性 | 三个聊天入口显示全部保持原样 | 用户硬性约束 |
| D11 | 业内参考 | Claude Code 模式（LLM 即 Router） | 业内压倒性选择，98.4% 确定性基础设施 |

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `messages` | ADD COLUMN | `type TEXT` — 消息类型（thinking/text/tool_call/tool_result/error） |
| `messages` | ADD COLUMN | `metadata TEXT` — JSON 元数据（token 用量、成本、工具详情、thinking 耗时） |
| `sessions` | ADD COLUMN | `workspace_id TEXT` — 关联 workspace（可为 null） |
| `sessions` | ADD COLUMN | `provider_session_id TEXT` — SDK resume 会话 ID |
| `chat_sessions` | DEPRECATE | 迁移后废弃（本次不做数据迁移） |
| `chat_messages` | DEPRECATE | 迁移后废弃 |

### New Type: CloneDef

```typescript
interface CloneDef {
  name: string                    // 'workspace' | 'scheduler' | 'archive' | 'resource'
  type: 'built-in' | 'user'
  persona: string                 // persona.md 内容
  skills: string[]                // 专属 skill 名称列表
  memoryScope: 'shared' | 'isolated'
  workspaceRef?: {                // 可选 workspace 绑定
    name: string
    path: string
    branch: string
  }
  config: {
    model?: string
    maxTurns?: number
    tools?: string[]              // 允许的工具列表
  }
}
```

### New Type: CloneSession (extends SessionRow)

```typescript
interface CloneSession extends SessionRow {
  clone_name: string              // 分身名称（必填）
  workspace_id: string | null     // workspace 关联
  provider_session_id: string | null  // SDK resume ID
}
```

### New Type: CloneMessage (extends MessageRow)

```typescript
interface CloneMessage extends MessageRow {
  type: string                    // 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error'
  metadata: string | null         // JSON: { tokens, cost, toolDetails, thinkingDuration }
}
```

## API Contracts

### 直接入口（Web UI 页面直连分身）

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | `/api/clones/:name/sessions` | server | `{ title? }` | `CloneSession` | 创建分身会话 |
| GET | `/api/clones/:name/sessions` | server | `?limit&cursor` | `CloneSession[]` | 列出分身会话 |
| GET | `/api/clones/:name/sessions/:id` | server | `?limit&before` | `CloneSession + messages` | 获取会话详情 |
| POST | `/api/clones/:name/sessions/:id/chat` | server | `{ message }` | SSE stream | 分身聊天（流式） |
| POST | `/api/clones/:name/sessions/:id/stop` | server | — | `{ success }` | 停止生成 |

### 统一入口（CLI / API）

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | `/api/agent/chat` | server | `{ message, org }` | SSE stream | Main Agent 入口（LLM 自行决定委托哪个分身） |

### 分身管理

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/clones` | server | — | `CloneDef[]` | 列出所有分身（内置 + 用户） |
| GET | `/api/clones/:name` | server | — | `CloneDef` | 获取分身详情 |
| POST | `/api/clones` | server | `CreateCloneRequest` | `CloneDef` | 创建用户分身 |
| DELETE | `/api/clones/:name` | server | — | `{ ok }` | 删除用户分身（内置不可删） |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-01 | 作为用户，我在 workspace 页面聊天 | Workspace 分身响应，拥有当前 workspace 上下文（代码、CLAUDE.md），前端 ChatPanel 显示与重构前一致 | 集成测试 + 前端手动检查 |
| AC-02 | 作为用户，我在 scheduler 页面聊天 | Scheduler 分身响应，能创建/管理定时任务，前端 ChatPanel 显示与重构前一致 | 集成测试 + 前端手动检查 |
| AC-03 | 作为用户，我使用 CLI `octopus agent chat` | Main Agent 判断意图并委托到对应分身处理 | 集成测试 |
| AC-04 | 作为系统，Archive 分身能访问所有分身的执行历史 | Archive 分身 context 包含各分身 own memory | 单元测试 |
| AC-05 | 作为系统，Resource 分身能安装 skills/agents/workflows | Resource 分身继承 ResourceAgentService 的能力 | 集成测试 |
| AC-06 | 作为用户，分身的聊天消息支持 thinking 块、工具调用卡片 | MessageRow 有 type + metadata 字段，前端渲染与重构前一致 | 集成测试 + 前端手动检查 |
| AC-07 | 作为系统，所有分身使用 Claude Code SDK resume 省 token | provider_session_id 正确传递和更新 | 集成测试 |
| AC-08 | 作为用户，我能看到内置分身列表 | GET /api/clones 返回 4 个内置分身 + 用户分身 | 集成测试 |
| AC-09 | 作为系统，分身记忆写入隔离 | Workspace 分身写入 built-in/workspace/memory/，不影响其他分身的 own memory | 单元测试 |
| AC-10 | 作为系统，OrchestratorService 不再存在 | 代码中无 OrchestratorService 类，无 classifyIntent/selectWorkflow/generateWorkflow 方法 | 静态检查 |

## Verification Strategy

### Global Config
- Environment: local dev (server:3001, web:3000)
- Test user: default org
- Data prefix: `TEST_CLONE_`

### Per-layer Methods

#### Unit Tests
- `CloneRuntime` 上下文组装：验证 persona + memory + skills 正确拼接
- `CloneRuntime` Provider 调用：验证 resume + append 参数正确传递
- 分身 CRUD：创建/读取/删除分身（内置不可删）
- 记忆共享策略：读全局 + 写隔离
- 技能叠加：全局 skills + 分身 skills 合并排序

#### Integration Tests
- 分身聊天 API 端到端：POST chat → SSE stream → 消息存储 → GET 读取验证
- 分身 Session CRUD：创建/列表/获取/删除
- Main Agent 统一入口：发送消息 → LLM 委托 → 分身处理 → SSE 返回
- Provider resume：第一次消息 → 保存 provider_session_id → 第二次消息带 resume

#### Browser E2E
- 不做（前端只改 API 路径，渲染逻辑不变）

#### Manual Checklist
- [ ] Workspace 页面聊天：消息发送、thinking 块显示、工具调用卡片、流式状态栏、会话切换
- [ ] Scheduler 页面聊天：消息发送、定时任务创建、右侧面板显示
- [ ] Agent 页面聊天：消息发送、意图处理、会话管理
- [ ] 三个入口的 SSE 流式渲染与重构前一致

### Prerequisites
- [ ] `@octopus/shared` 类型定义完成
- [ ] SQLite migration 脚本（ALTER TABLE）
- [ ] CloneRuntime 基础设施就绪

## Risks & Notes

- **R1: 前端 API 切换风险** — 三个聊天入口的 API 路径同时变更，需要确保 useChatStream hook 兼容新 API 响应格式
- **R2: OrchestratorService 拆解遗漏** — 需仔细 grep 所有引用点（routes、services、tests），确保无残留依赖
- **R3: Claude Code SDK resume 兼容性** — append system prompt 在 resume 模式下是否每次生效，需要实测验证
- **R4: 内置分身初始化** — 首次启动时 built-in/ 目录不存在，需要 auto-init 逻辑
- **R5: 渐进式迁移** — ChatService/ChatDAO 不会立即删除，需要与新体系并存直到前端完全切换

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **分身 (Clone)** | 拥有独立记忆/技能/人格的 Agent 实例，不是角色换皮 |
| **内置分身 (Built-in Clone)** | 系统预定义的 4 个分身：workspace / scheduler / archive / resource |
| **CloneRuntime** | 所有分身共享的基础设施层，负责上下文组装、Provider 调用封装、错误恢复 |
| **双路径架构 (Dual-Path)** | 统一入口（Main Agent tool-calling）+ 直接入口（页面直连分身） |
| **Main Agent** | 统一入口的分身，通过 LLM tool-calling 委托其他分身处理 |
| **记忆读共享/写隔离** | 分身能读取全局记忆（只读），但写入自己独立的记忆空间 |
| **技能叠加** | 分身继承全局 skills + 自己专属 skills |
| **人格替换** | 分身用自己的 persona.md，完全替换主 Agent 的 persona |
| **provider_session_id** | Claude Code SDK 的 resume 会话 ID，用于跨请求保持对话上下文、省 token |
