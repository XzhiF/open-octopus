# Agent Clone System Refactor — 架构归档

> **日期**: 2026-07-24
> **分支**: feat-builit-in-engines
> **PR**: [#30](https://github.com/XzhiF/open-octopus/pull/30)
> **变更**: +3,195 / -1,644 lines, 39 files

## 1. 系统架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         客户端                                    │
│   Web UI (workspace/scheduler 页面)     CLI (octopus agent chat)  │
└───────────┬──────────────────────────────────────┬───────────────┘
            │ 直接入口                              │ 统一入口
            │ /api/clones/:name/sessions/*          │ /api/agent/chat
            ▼                                      ▼
┌───────────────────────┐              ┌───────────────────────────┐
│  Clone Session Routes │              │   Main Agent Route        │
│  (routes/clone/)      │              │   (routes/agent/main-     │
│                       │              │    agent-route.ts)        │
│  页面直连分身          │              │                           │
│  零路由延迟            │              │  LLM 自行决定委托哪个分身   │
│                       │              │  via tool-calling:         │
│                       │              │  delegate_to_workspace     │
│                       │              │  delegate_to_scheduler     │
│                       │              │  delegate_to_archive       │
│                       │              │  delegate_to_resource      │
└───────────┬───────────┘              └───────────┬───────────────┘
            │                                      │
            └──────────────┬───────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │        CloneRuntime          │
            │   (services/agent/clone-     │
            │    runtime.ts)               │
            │                              │
            │  1. 上下文组装                │
            │     persona + skills + memory│
            │     (读共享/写隔离)           │
            │                              │
            │  2. Provider 调用封装         │
            │     Claude SDK + resume      │
            │     + append clone context   │
            │                              │
            │  3. 错误恢复                  │
            │     fallback / retry / log   │
            └──────────────┬───────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                  │
         ▼                 ▼                  ▼
┌─────────────────┐ ┌──────────┐ ┌───────────────────────────┐
│  4 Built-in     │ │ User     │ │   Unified Session Layer   │
│  Clones         │ │ Clones   │ │   (AgentSessionDAO)       │
│                 │ │          │ │                           │
│  workspace      │ │ (自定义)  │ │  sessions 表:             │
│  scheduler      │ │          │ │   + scope_id              │
│  archive        │ │          │ │   + provider_session_id   │
│  resource       │ │          │ │                           │
│                 │ │          │ │  messages 表:              │
│                 │ │          │ │   + type                  │
│                 │ │          │ │   + metadata              │
└────────┬────────┘ └────┬─────┘ └───────────────────────────┘
         │               │
         ▼               ▼
┌─────────────────────────────────────────────────┐
│              Filesystem Layer                    │
│  ~/.octopus/agent/                              │
│  ├── built-in/           ← 内置分身             │
│  │   ├── workspace/                             │
│  │   │   ├── persona.md                         │
│  │   │   ├── config.json                        │
│  │   │   └── memory/                            │
│  │   │       ├── long-term.md                   │
│  │   │       └── daily/                         │
│  │   ├── scheduler/                             │
│  │   ├── archive/                               │
│  │   └── resource/                              │
│  ├── clones/             ← 用户分身             │
│  ├── memory/             ← 全局共享记忆(只读)    │
│  │   ├── long-term.md                           │
│  │   └── daily/                                 │
│  ├── skills/             ← 全局技能(继承)        │
│  └── persona.md          ← 主 Agent 人格        │
└─────────────────────────────────────────────────┘
```

## 2. 文件结构

```
packages/
├── shared/src/types/
│   └── agent.ts                          ← [MODIFIED] +CloneDef, CloneSession, CloneMessage 类型
│
├── server/src/
│   ├── db/
│   │   ├── types.ts                      ← [MODIFIED] SessionRow +scope_id, provider_session_id; MessageRow +type, metadata; CloneRow +type
│   │   ├── schema.sql                    ← [MODIFIED] Schema v27: ALTER TABLE 语句
│   │   ├── schema.ts                     ← [MODIFIED] ensureColumn() 幂等迁移
│   │   └── dao/
│   │       ├── agent-session-dao.ts      ← [MODIFIED] +updateProviderSession(), +insertCloneMessage()
│   │       └── clone-dao.ts             ← [MODIFIED] +type 字段支持
│   │
│   ├── routes/
│   │   ├── clone/
│   │   │   └── index.ts                 ← [NEW] 分身直连 API (CRUD + SSE chat + stop)
│   │   └── agent/
│   │       ├── main-agent-route.ts      ← [NEW] 统一入口 (LLM tool-calling 委托)
│   │       ├── chat-routes.ts           ← [SIMPLIFIED] 移除 OrchestratorService 调用
│   │       └── index.ts                ← [MODIFIED] 挂载 main-agent-route
│   │
│   ├── services/agent/
│   │   ├── clone-runtime.ts             ← [NEW] ★ 核心基础设施层
│   │   ├── builtin-clones.ts           ← [NEW] 4 个内置分身定义 + persona
│   │   ├── clone-init-service.ts       ← [NEW] 启动时自动初始化内置分身
│   │   ├── paths.ts                    ← [MODIFIED] +getBuiltInCloneDir(), +getBuiltInCloneMemoryDir()
│   │   ├── orchestrator-service.ts     ← [DELETED] -1,114 行
│   │   ├── system-prompt-assembler.ts  ← [UNCHANGED] 仍由 Main Agent 使用
│   │   ├── memory-service.ts           ← [UNCHANGED] 仍为全局记忆服务
│   │   ├── skill-loader.ts            ← [UNCHANGED] 被 CloneRuntime 复用
│   │   ├── agent-service.ts           ← [UNCHANGED] 仍管理 stream registry
│   │   └── __tests__/
│   │       └── clone-runtime.test.ts   ← [NEW] 11 个单元测试
│   │
│   ├── services/archive/
│   │   └── archive-analysis-service.ts ← [NEW] 从 OrchestratorService 提取
│   │
│   ├── services/
│   │   └── resource-agent-service.ts   ← [MODIFIED] 吸收 executeTask() 等方法
│   │
│   └── __tests__/
│       ├── agent-journey.test.ts       ← [MODIFIED] 适配新架构
│       ├── agent-migrations.test.ts    ← [MODIFIED] Schema v27
│       └── orchestrator-service.test.ts← [DELETED]
```

## 3. 请求流向

### 场景 A: 用户在 Workspace 页面聊天（直接入口）

```
浏览器 POST /api/clones/workspace/sessions/:id/chat
  → clone/index.ts: resolveCloneDef('workspace') → BUILTIN_CLONES[0]
  → new CloneRuntime(workspaceCloneDef, org)
  → runtime.assembleContext()
      → 读全局 memory (只读) + workspace persona + 全局 skills
  → runtime.chat(message, sessionId, providerSessionId, cwd)
      → provider.sendQuery(msg, cwd, resumeId, { append: context })
      → SSE stream 回前端
  → sessionDAO.updateProviderSession(id, newSessionId)
```

### 场景 B: CLI `octopus agent chat "每天3点跑测试"`（统一入口）

```
CLI POST /api/agent/chat
  → main-agent-route.ts: 创建/复用 Main Agent session
  → SystemPromptAssembler.assemble() + DELEGATION_TOOLS_PROMPT
  → provider.sendQuery(message, cwd, undefined, { append: systemPrompt })
  → LLM 判断意图 → tool call: delegate_to_scheduler("每天3点跑测试")
  → 解析 tool call → new CloneRuntime(schedulerCloneDef, org)
  → schedulerRuntime.chat(delegatedMessage, ...)
  → SSE stream 结果回 CLI
```

## 4. 数据流

### 消息存储

```
sessions 表: { id, org, clone_name, scope_id, provider_session_id, session_type, ... }
messages 表: { id, session_id, role, type, content, metadata, tool_calls, ... }
```

### 上下文组装 (CloneRuntime.assembleContext)

```
┌─────────────────────────────────────────────────┐
│ System Prompt Append                            │
│ ├── [1] Persona    ← clone.persona (替换全局)    │
│ ├── [2] Memory     ← 全局 long-term + daily (只读)│
│ │                + clone own memory (如有)       │
│ ├── [3] Skills     ← 全局 skills + clone 专属     │
│ └── [4] Context    ← workspace rules (如适用)     │
└─────────────────────────────────────────────────┘
```

### 记忆写入

```
分身产生的记忆 → built-in/{name}/memory/ (隔离)
全局记忆更新  → 仅 Archive 分身可写 (定期提炼)
```

## 5. 4 个内置分身

| 分身 | 职责 | Persona | Skills | Memory |
|------|------|---------|--------|--------|
| **workspace** | 当前 workspace 全能助手 | 全栈开发助手 | 继承全局 skills | shared read + isolated write |
| **scheduler** | 定时任务管家 | 定时任务管理专家 | octo-schedule-manager | isolated |
| **archive** | 归档 + 经验提取 + 项目知识库 | 工程分析师 + 知识策展人 | octo-archive-analyst | shared read |
| **resource** | 资源库管理员 | 资源操作专家 | octo-resource-manager | isolated |

### 共享策略

- **记忆**: 读共享/写隔离 — 分身能读全局记忆（只读），写入自己独立的记忆空间
- **技能**: 叠加 — 分身继承全局 skills + 自己专属 skills
- **人格**: 替换 — 分身用自己的 persona.md，完全替换主 Agent 的 persona

## 6. 关键设计决策

| # | 决策 | 结论 | 理由 |
|---|------|------|------|
| D1 | Clone 本质 | 拥有独立记忆/技能/人格的 Agent 实例 | 不是角色换皮 |
| D2 | 内置分身 | 4 个: workspace / scheduler / archive / resource | 覆盖系统核心场景 |
| D3 | 架构模式 | 双路径: Main Agent tool-calling + 页面直连 | CLI 统一入口 + Web 零延迟直连 |
| D4 | Session 统一 | AgentSession + 扩展 MessageRow | AgentSession 已有分身基因 |
| D5 | Provider 统一 | Claude Code SDK + resume + append | 所有分身支持 resume 省 token |
| D6 | OrchestratorService | 拆解消除 → CloneRuntime | 意图分类被 LLM 取代 |
| D7 | 上下文组装 | 记忆读共享/写隔离 + 技能叠加 + 人格替换 | 分身能利用全局知识，写入隔离 |
| D8 | scope_id | 通用作用域 ID (TEXT 单值) | 替代 workspace_id，未来可扩展 |
| D9 | 业内参考 | Claude Code 模式 (LLM 即 Router) | 业内压倒性选择 |

## 7. API 清单

### 直接入口（Web UI 页面直连分身）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/clones/:name/sessions` | 创建分身会话 |
| GET | `/api/clones/:name/sessions` | 列出分身会话 |
| GET | `/api/clones/:name/sessions/:id` | 获取会话详情 + 消息 |
| POST | `/api/clones/:name/sessions/:id/chat` | 分身聊天 (SSE stream) |
| POST | `/api/clones/:name/sessions/:id/stop` | 停止生成 |

### 统一入口（CLI / API）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/agent/chat` | Main Agent 入口 (LLM 自行决定委托) |

### 分身管理

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/clones` | 列出所有分身 (内置 + 用户) |
| GET | `/api/clones/:name` | 获取分身详情 |
| POST | `/api/clones` | 创建用户分身 |
| DELETE | `/api/clones/:name` | 删除用户分身 (内置不可删) |

## 8. 后续待办

| # | 事项 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | T8: 前端 API 路径切换 | P1 | Workspace/Scheduler 页面 chat 切到 `/api/clones/:name/sessions/*` |
| 2 | Pre-existing 测试修复 | P2 | archive-routes (10) + config-manager (4) 与本次重构无关 |
| 3 | SDK resume + append 实测 | P2 | 手动验证 workspace 聊天中 resume 是否生效 |
| 4 | ChatService/ChatDAO 清理 | P3 | 前端完全切换后废弃旧体系 |
