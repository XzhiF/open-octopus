# 04 — CLI-Agent Bridge: 现有架构如何支持 CLI 调用 Agent?

Type: research
Status: resolved
Blocked by: None

## Answer

### 架构总览

```
CLI (Commander.js)
  │  HTTP fetch (native)
  ▼
Server (Hono, port 3001)
  │  /api/agent/* routes
  ▼
Main Agent Route (/api/agent/chat)
  │  SystemPromptAssembler + delegation detection
  ▼
CloneRuntime (per-clone infrastructure)
  │  context assembly + Claude SDK
  ▼
@octopus/providers → Claude Agent SDK → LLM
```

### 1. CloneRuntime — 分身共享基础设施 (`clone-runtime.ts`)

`CloneRuntime` 是所有 clone 的执行引擎，职责三层:

| 层 | 职责 | 实现 |
|---|------|------|
| Context Assembly | 组装 clone 专属 system prompt | persona + shared memory + own memory + guidance |
| Provider Call | 统一 Claude SDK 调用 | `getProvider('claude').sendQuery()` + resume/append |
| Error Recovery | 优雅降级 | resume 失败 → retry without resume → error chunk |

关键方法:
- `chat(message, sessionId, providerSessionId, cwd, abortSignal)` → `AsyncGenerator<MessageChunk>` — 流式返回
- `assembleContext()` → 拼接 persona + memory + guidance 为 system prompt
- `getPlugins()` → ADR-006 plugin 路径，SDK 自动扫描 `skills/` 子目录发现技能
- `getDefaultCwd()` → clone 目录作为工作目录

### 2. REST API 端点 (完整的 clone 交互面)

**Main Agent 统一入口** (`main-agent-route.ts`):
| Method | Path | 用途 |
|--------|------|------|
| POST | `/api/agent/chat` | 统一入口: LLM 路由 + 确定性 delegate_to |

`/api/agent/chat` 支持两种模式:
- **确定性委派**: `body.delegate_to = "workspace"` → 直接路由到指定 clone 的 CloneRuntime
- **LLM 路由**: 无 delegate_to → Main Agent LLM 判断，检测 `delegate_to_*` tool call → 触发 CloneRuntime

**Session Chat** (`chat-routes.ts`):
| Method | Path | 用途 |
|--------|------|------|
| POST | `/api/agent/sessions/:id/chat` | Session 级 SSE 流式对话 (legacy) |
| POST | `/api/agent/sessions/:id/stop` | 停止生成 |

**Clone 生命周期** (`clone-routes.ts`):
| Method | Path | 用途 |
|--------|------|------|
| POST | `/api/agent/clones/:name/merge` | 合并记忆到主 Agent + 删除 clone |
| POST | `/api/agent/clones/:name/delegate/cancel` | 取消活跃委派 |
| POST | `/api/agent/clones/:name/activate` | 设置为活跃 clone |
| DELETE | `/api/agent/clones/active` | 停用活跃 clone |
| GET | `/api/agent/clones/:name/experiences` | 经验列表 (stub) |

### 3. CLI HTTP 客户端 (`cli/src/commands/agent.ts`)

CLI 是 Server 的 **纯 HTTP 客户端**，使用 native `fetch`:

```typescript
// 工具函数
function getServerUrl(): string    // env OCTOPUS_SERVER_URL ?? "http://localhost:3001"
function agentHeaders(org?)        // Content-Type + Bearer token + X-Octopus-Org
function agentGet(path, org?)      // GET /api/agent{path}
function agentPost(path, body, org?) // POST /api/agent{path}
function agentDelete(path, org?)   // DELETE /api/agent{path}
```

已有 CLI 命令:
- `octopus agent chat "<message>"` — SSE 流式对话 (创建 session → POST chat → 读 SSE)
- `octopus agent sessions` — 会话列表
- `octopus agent clones` — 分身列表
- `octopus agent clone <action>` — create/use/merge/delete
- `octopus agent memory <action>` — show/search/add/rebuild-fts/archive
- `octopus agent skills` — 技能列表
- `octopus agent config` — 配置管理
- `octopus agent tasks` — 任务管理
- `octopus agent health` — 健康检查

### 4. Clone Resolver — 文件系统解析 (`clone-resolver.ts`)

纯文件系统实现，不依赖数据库:
- **Built-in clones**: `~/.octopus/agent/built-in/{name}/` — 代码中硬编码 (`BUILTIN_CLONES`)
- **User clones**: `~/.octopus/agent/clones/{name}/` — config.json + persona.md

`resolveCloneInfo(name)` → `CloneInfo { name, display_name, type, persona, skills, memory_scope, status }`
`createUserClone(params)` → 创建目录 + config.json + persona.md + skills/ + memory/

### 5. Main Agent 如何委派到 Clone?

两种委派路径:

**路径 A: 确定性委派 (body.delegate_to)**
```
POST /api/agent/chat { message, delegate_to: "workspace" }
  → resolveCloneDefFromFs("workspace")
  → new CloneRuntime(cloneDef, org)
  → runtime.chat(message, sessionId, null, cwd)
  → SSE stream (delegation_start → text_delta → delegation_end → done)
```

**路径 B: LLM Tool-based 委派**
```
POST /api/agent/chat { message }
  → Main Agent LLM (system prompt 包含 DELEGATION_TOOLS_PROMPT)
  → LLM 产生 tool_call: delegate_to_workspace { task: "..." }
  → 检测 toolName.startsWith("delegate_to_")
  → executeDelegation() → CloneRuntime.chat()
  → SSE stream 继续
```

### 6. 关键回答

**Q: 是否有 REST API 接受消息并返回 clone 的响应?**
A: 有。`POST /api/agent/chat` 是统一入口:
- `{ message, delegate_to: "workspace" }` → 确定性路由到 workspace clone
- `{ message }` → Main Agent LLM 自动决定是否委派
- 响应是 SSE 流: `text_delta`, `tool_call`, `delegation_start/end`, `done` 事件

**Q: CLI 是否有 HTTP 客户端连接 Server?**
A: 有。`cli/src/commands/agent.ts` 有完整的 fetch-based HTTP 客户端，覆盖所有 agent API。
Server URL 通过 `OCTOPUS_SERVER_URL` 环境变量配置，默认 `http://localhost:3001`。

**Q: Main Agent 如何委派到 workspace clone?**
A: 两种机制:
1. 确定性 `delegate_to` 字段 (客户端显式指定)
2. LLM tool-calling (`delegate_to_*` 工具名模式匹配)
两者最终都通过 `CloneRuntime.chat()` 执行。

**Q: CLI 触发 agent 行为的最简路径?**
A: `POST /api/agent/chat` with `{ message, delegate_to: "workspace" }`:
- 不需要预先创建 session (服务端自动创建)
- 直接路由到 workspace clone 的 CloneRuntime
- SSE 流式返回结果

### 7. 对 Workflow Simulator V2 的启示

现有架构已提供完整的 CLI → Agent 桥接:

1. **直接复用**: `octopus agent chat` + `delegate_to` 即可触发 workspace clone 行为
2. **无需新建**: 不需要新的 HTTP 客户端或 API 端点
3. **SSE 解析**: CLI 已有 SSE 读取模式 (`chat` 命令)，可复用
4. **扩展点**: 如需 simulator 专属路由，可在 `misc-routes.ts` 或新建 `simulator-routes.ts` 中添加，挂载在 `/api/agent/` 下
