# 后端架构契约 (architecture-explorer)

> 本文档为 `00-host-contract.md` 的子文档，专注后端技术栈与约束。

## 1. 运行时与框架

| 项 | 值 |
|----|-----|
| 运行时 | Node.js (>= 22) |
| HTTP 框架 | **Hono v4** (非 Express/Koa) |
| HTTP 适配器 | `http.createServer()` 手动桥接 (非 `@hono/node-server` 默认中间件) |
| 构建 | tsup (ESM + CJS 双格式) |
| 测试 | Vitest |
| 包管理 | pnpm workspace |

## 2. 数据库层

| 项 | 值 |
|----|-----|
| 引擎 | SQLite (better-sqlite3 v12) |
| API | **同步** (非异步) |
| Journal | WAL 模式 |
| 文件位置 | `~/.octopus/db/octopus.db` (可通过 `OCTOPUS_DB_PATH` 覆盖) |
| Schema 版本 | `SCHEMA_VERSION = 25`，通过 `PRAGMA user_version` 追踪 |
| Schema 文件 | `packages/server/src/db/schema.sql` — 全部 `CREATE TABLE IF NOT EXISTS`，幂等 |
| 表数量 | 28 表 + 3 FTS5 虚拟表 + 4 触发器 |

### DAO 模式 (无 ORM)

- **BaseDAO** 抽象基类 (`packages/server/src/db/dao/base.ts`):
  - `stmt(sql)` — 预处理语句缓存 (Map)
  - `transaction(fn)` — 事务包装器
  - `paginate(dataSql, countSql, params, page, pageSize)` — 统一分页
- 13 个 DAO 类，每个继承 `BaseDAO`，位于 `packages/server/src/db/dao/`
- 导出聚合在 `dao/index.ts`

### AllDAOs 接口

```typescript
interface AllDAOs {
  workspace: WorkspaceDAO
  execution: ExecutionDAO
  tokenUsage: TokenUsageDAO
  scheduleConfig: ScheduleConfigDAO
  scheduleRun: ScheduleRunDAO
  chat: ChatDAO
  org: OrgDAO
  agentSession: AgentSessionDAO
  evolution: EvolutionDAO
  clone: CloneDAO
  safety: SafetyDAO
  pendingReview: PendingReviewDAO
  knowledgeEffectiveness: KnowledgeEffectivenessDAO
}
```

**新 DAO 必须:**
1. 创建 `packages/server/src/db/dao/<name>-dao.ts`，继承 `BaseDAO`
2. 在 `dao/index.ts` 中 re-export
3. 在 `server/src/index.ts` 的 `AllDAOs` 接口和 `createAllDAOs()` 中注册
4. 在 lazy DAO fallback 中添加对应的 `lazyDAO(XxxDAO)`

## 3. 路由约定

### 工厂函数模式

所有路由使用 `createXxxRoutes()` 工厂函数，通过构造函数注入依赖:

```typescript
// 示例: packages/server/src/routes/workspace.ts
export function createWorkspaceRoutes(
  workspaceService: WorkspaceService,
  orgDAO: OrgDAO,
  workspaceDAO: WorkspaceDAO
): Hono {
  const workspaceRoutes = new Hono()
  workspaceRoutes.get("/", (c) => { ... })
  workspaceRoutes.post("/", async (c) => { ... })
  return workspaceRoutes
}
```

### 注册位置

所有路由在 `server/src/index.ts` 中通过 `app.route()` 注册，统一 `/api/*` 前缀:

```
/api/orgs              → createOrgRoutes
/api/workspaces        → createWorkspaceRoutes / createPipelineRoutes / chainRoutes
/api/workspaces/:id/*  → workflows / executions / analytics / chat / files / events / schedules
/api/dashboard         → createDashboardRoutes
/api/agent             → createAgentRoutes (Bearer token 认证)
/api/knowledge         → createKnowledgeRoutes
/api/review            → createReviewRoutes
/api/archive           → createArchiveRoutes
/api/actuator          → createActuatorRoutes
/api/scheduler         → createSchedulerRoutes (启动后动态注册)
/api/workflows/built-in → builtInWorkflowRoutes
```

### 错误响应格式

**普通 API** (errorHandler middleware):
```json
{ "error": "message string" }
```

**Agent API** (`/api/agent/*`):
```json
{ "error": { "code": "ERROR_CODE", "message": "human readable" } }
```

## 4. 中间件栈

按注册顺序:
1. **CORS** — 允许 localhost + 局域网 IP + `OCTOPUS_FRONTEND_URL`
2. **Logger** — Hono 内置请求日志
3. **Body Limit** — 1MB (`1024 * 1024`)
4. **Security Headers** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy
5. **Agent Auth** — Bearer token 仅在 `/api/agent/*` 路由

## 5. 服务层

Service 类接收 DAO 实例作为构造参数:

```typescript
// 启动时创建，通过 DI 注入路由
workspaceService = new WorkspaceService(daos.workspace)
chatService = new ChatService(daos.chat, sse)
observability = new ObservabilityService(daos.execution, daos.tokenUsage, new PrivacyFilter())
```

## 6. 特殊机制

### Lazy DAO Proxy (测试模式)

```typescript
// 当 process.env.VITEST 时，db 为 null，路由使用 Proxy DAO
function lazyDAO<T>(Ctor: new (db: any) => T): T {
  let real: T | null = null
  return new Proxy({} as any, {
    get(_, prop) {
      if (!real) real = new Ctor(getDb())  // 延迟到首次调用时初始化
      const val = (real as any)[prop]
      return typeof val === 'function' ? val.bind(real) : val
    },
  }) as T
}
```

### Feature Flags

```typescript
import { getFlag } from "./config/feature-flags"

// 用法
if (getFlag('scheduler')) { ... }

// 环境变量覆盖: OCTOPUS_FF_SCHEDULER=true/false
// 配置文件: pipeline.yaml → observability.scheduler: true
```

### SSE (Server-Sent Events)

`SSEService` 单例用于实时推送执行事件到前端。

### WebSocket

`createYjsWebSocketServer(server)` 挂载在 HTTP server 上，用于 Yjs 协同编辑和聊天。

## 7. 启动与端口

| 模式 | 端口 |
|------|------|
| 主仓库 dev | 3001 |
| worktree dev | 3100-3598 (hash) |
| prod | 3099 |

- Graceful shutdown: SIGINT/SIGTERM → 3s 超时强制退出
- `--force` 参数: 自动 kill 占用端口的进程
- `--port=N` 参数: 自定义端口

## 8. 构建命令

```bash
pnpm build:server    # tsup 构建 server 包
pnpm dev:server      # 启动开发 server
pnpm test            # vitest run (根目录)
```

## 9. 已知风险

1. **无事务抽象暴露给路由层** — BaseDAO 有 `transaction()` 方法，但路由层无显式事务 API
2. **Schema 迁移为手动** — `schema.sql` 只 `IF NOT EXISTS`，无回滚路径
3. **Agent Auth 为占位级** — Bearer token 检查但无完整密钥验证逻辑
