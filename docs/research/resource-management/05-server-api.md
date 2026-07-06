# 5. Server API 设计

## 5.1 设计原则：Server 是唯一入口

Server 是 ResourceManager 的唯一持有者。CLI 和 Web UI 都通过 HTTP 调用 Server API，Server API 调用 ResourceManager 单例。

```
CLI ──────┐
          ├──→ HTTP ──→ Server Routes ──→ ResourceManager (单例) ──→ 文件系统
Web UI ───┘
```

**为什么不让 CLI 直接操作 ResourceManager**：
- 避免并发冲突（CLI 进程和 Server 进程同时操作 registry.json）
- 避免双轨代码（CLI 一套逻辑，Server 一套逻辑）
- Server 持有内存缓存（RegistryStore），CLI 进程无法共享
- 与现有 `workspace`、`agents` 等 API 模式一致

## 5.2 路由概览

所有路由前缀: `/api/resources`

### 资源操作

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| GET | `/` | 资源列表（支持 type/query/installed/tag 过滤） | auth |
| GET | `/:type/:name` | 资源详情 | auth |
| GET | `/:type/:name/deps` | 依赖树（forward + reverse） | auth |
| POST | `/install` | 安装资源（支持 ref + scope） | auth |
| POST | `/uninstall` | 卸载资源 | auth |
| POST | `/gc` | 垃圾回收 | auth |
| POST | `/sync` | 漂移检测/修复 | auth |
| GET | `/audit` | 审计日志查询 | auth |
| GET | `/audit/export` | 审计日志导出 | auth |
| GET | `/doctor` | 健康检查 | auth |

### 集合源管理

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| POST | `/source/add` | 添加集合源（clone + 分析 + 信任） | auth |
| GET | `/source/list` | 列出已添加的集合源 | auth |
| POST | `/source/update` | 拉取最新版本并重新分析 | auth |
| POST | `/source/analyze` | 仅分析不安装（预览资源列表） | auth |
| GET | `/source/:name` | 集合源详情（包含哪些资源） | auth |
| DELETE | `/source/:name` | 移除集合源 | auth |

## 5.3 路由实现模式

### 工厂函数

```typescript
// packages/server/src/routes/resource/index.ts

export function createResourceRoutes(getManager: () => ResourceManager): Hono {
  const app = new Hono()

  // 全局中间件
  app.use("*", resourceCors)        // CORS (仅信任 localhost/127.0.0.1)
  app.use("*", agentAuthMiddleware)  // Bearer token 认证
  app.use("*", requireJsonBody)     // POST 必须 Content-Type: application/json

  // 路径参数验证
  const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/
  const VALID_TYPES = new Set(["skill", "agent", "workflow"])

  // 错误处理 — 不泄漏内部错误
  function handleError(c: Context, err: unknown) {
    if (err instanceof ResourceError) {
      return c.json(
        { error: { code: err.code, message: err.message, hint: err.suggestion } },
        err.httpStatus,
      )
    }
    console.error("[resource] Unexpected error:", err)
    return c.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, 500)
  }

  // ... 路由定义
  return app
}
```

### 路由处理示例

```typescript
// POST /install
app.post("/install", async (c) => {
  try {
    const mgr = getManager()
    const body = await c.req.json<{ ref?: string }>()
    if (!body.ref || typeof body.ref !== "string") {
      return c.json({ error: { code: "INVALID_PARAM", message: "..." } }, 400)
    }
    const result = await mgr.install(body.ref)
    return c.json({ data: result })
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /:type/:name
app.get("/:type/:name", (c) => {
  try {
    const mgr = getManager()
    const type = c.req.param("type")
    const name = c.req.param("name")
    if (!VALID_TYPES.has(type)) {
      return c.json({ error: { code: "INVALID_PARAM", message: `Invalid type: '${type}'` } }, 400)
    }
    if (!SAFE_NAME_RE.test(name)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid name format" } }, 400)
    }
    const entry = mgr.info(name, type as ResourceType)
    if (!entry) {
      return c.json({ error: { code: "RESOURCE_NOT_FOUND", message: `...` } }, 404)
    }
    return c.json({ data: entry })
  } catch (err) {
    return handleError(c, err)
  }
})
```

## 5.4 端点详细设计

### GET /api/resources

```typescript
// Query params
interface ListQuery {
  type?: 'skill' | 'agent' | 'workflow'
  query?: string          // 全文搜索 (name + description)
  installed?: boolean     // 仅已安装
  tag?: string            // 按标签过滤
}

// Response
interface ListResponse {
  data: RegistryEntry[]
  meta: { total: number; returned: number }
}
```

### POST /api/resources/install

```typescript
// Request
interface InstallRequest {
  ref: string                      // "builtin:<name>" | "local:<path>" | "git:<url>"
  scope?: 'user' | 'org' | 'workspace'  // 安装范围（默认 user）
}

// Response
interface InstallResponse {
  data: RegistryEntry | RegistryEntry[]  // 单个资源或集合源的所有资源
  meta?: {
    source?: string                // 集合源名称（如 "agency-agents-zh"）
    count?: number                 // 安装的资源数量（集合源时）
  }
}

// 流程（单个资源 ref）:
// 1. parseRef(ref) → { type, resourceType, value }
// 2. SourceProvider.resolve(value, resourceType) → manifest
// 3. RegistryStore.register(manifest)
// 4. DependencyResolver.resolveTree(name) → 拓扑排序
// 5. 按序安装每个依赖 (InstallTransaction 保护)
// 6. 根据 scope 选择目标目录
// 7. AuditLogger.log("install")

// 流程（集合源 git: ref）:
// 1. parseRef(ref) → { type: "git", value: url }
// 2. SourceManager.getByName(url) → source entry
// 3. 从 registry 查找 source 的所有资源
// 4. 执行 setup（如果有）
// 5. 批量安装到 scope 对应的目标目录
// 6. AuditLogger.log("source.installed")
```

### POST /api/resources/uninstall

```typescript
// Request
interface UninstallRequest {
  name: string
  type: 'skill' | 'agent' | 'workflow'
}

// Response
interface UninstallResponse {
  data: { name: string; type: string; uninstalled: boolean }
}

// 流程:
// 1. RegistryStore.get(name, type) → entry
// 2. DependencyResolver.getReverseDeps(name) → 检查反向依赖
// 3. WorkspaceUninstaller.uninstall(name, type, installPath)
// 4. RegistryStore.updateInstalled(name, type, false)
// 5. LockManager.remove(name, type)
// 6. AuditLogger.log("uninstall")
```

### GET /api/resources/:type/:name/deps

```typescript
// Response
interface DepsResponse {
  data: {
    forward: Array<{ name: string; type: string; version: string }>  // 我依赖的
    reverse: Array<{ name: string; type: string; version: string }>  // 依赖我的
  }
}
```

### GET /api/resources/audit

```typescript
// Query params
interface AuditQuery {
  last?: number     // 最近 N 条（max 1000）
  action?: string   // install | uninstall | gc | sync | doctor
  resource?: string // 按资源名过滤
}

// Response
interface AuditResponse {
  data: AuditEntry[]
  meta: { total: number; returned: number }
}
```

### POST /api/resources/sync

```typescript
// Request
interface SyncRequest {
  fix?: boolean          // 是否自动修复
  targets?: string[]     // 限定修复范围
}

// Response
interface SyncResponse {
  data: {
    drifts: Array<{ resource: string; type: string; issue: string; fixed: boolean }>
    totalDrifts: number
  }
}
```

### POST /api/resources/gc

```typescript
// Request
interface GcRequest {
  dryRun?: boolean
}

// Response
interface GcResponse {
  data: {
    removed: string[]
    freedBytes: number
    freedHuman: string   // e.g. "4.4 KB"
  }
}
```

### GET /api/resources/doctor

```typescript
// Response
interface DoctorResponse {
  data: {
    checks: Array<{ name: string; healthy: boolean; detail?: string }>
    healthy: boolean
  }
}

// 检查项:
// 1. registry_integrity — registry.json 可读
// 2. lock_consistency — resources.lock 与 workspace 一致
// 3. stale_locks — 无过期 .lock 文件
// 4. cache_references — 所有 installPath 存在
```

## 5.8 集合源端点详细设计

### POST /api/resources/source/add

```typescript
// Request
interface SourceAddRequest {
  url: string   // GitHub 仓库 URL
}

// Response
interface SourceAddResponse {
  data: {
    name: string                   // 推断的集合源名称（repo 名）
    url: string
    manifest: {
      resources: {
        skills: string[]           // 发现的 skill 名称
        agents: string[]
        workflows: string[]
      }
      setup?: string               // 发现的 setup 命令
      discoveryMethod: 'manifest' | 'ai-analysis' | 'convention-scan'
    }
    trustStatus: 'added' | 'already-trusted'
  }
}

// 流程:
// 1. 校验 URL 格式（必须是 https://github.com/...）
// 2. 检查 allowlist 去重
// 3. git clone --depth 1 → cache/sources/{name}/
// 4. 三层降级发现资源:
//    a. 有 octopus-resource.json → 解析
//    b. LLM 可用 → 调用 octo-source-analyzer skill
//    c. 兜底 → 约定扫描
// 5. 注册 source entry + 所有 resource entries 到 registry
// 6. 添加到 config.yaml resource_sources.trusted
// 7. AuditLogger.log("source.added")
```

### POST /api/resources/source/update

```typescript
// Request
interface SourceUpdateRequest {
  name?: string   // 不指定则更新全部
}

// Response
interface SourceUpdateResponse {
  data: Array<{
    name: string
    changes: {
      added: number
      modified: number
      removed: number
      total: number
    }
  }>
}

// 流程:
// 1. 对每个 source: cd cache/sources/{name}/ && git pull
// 2. 重新分析（三层降级）
// 3. 对比新旧 manifest → 计算变更
// 4. 更新 registry
// 5. AuditLogger.log("source.updated")
```

### POST /api/resources/source/analyze

```typescript
// Request
interface SourceAnalyzeRequest {
  url: string
}

// Response — 同 SourceAddResponse 但不注册/不信任
interface SourceAnalyzeResponse {
  data: {
    name: string
    url: string
    manifest: { ... }    // 同 add
  }
}
```

### GET /api/resources/source/list

```typescript
// Response
interface SourceListResponse {
  data: Array<{
    name: string
    url: string
    trusted: boolean
    addedAt: string
    resourceCount: { skills: number; agents: number; workflows: number }
    discoveryMethod: 'manifest' | 'ai-analysis' | 'convention-scan'
  }>
  meta: { total: number }
}
```

### GET /api/resources/source/:name

```typescript
// Response
interface SourceDetailResponse {
  data: {
    name: string
    url: string
    trusted: boolean
    addedAt: string
    cachePath: string
    manifestPath: string
    discoveryMethod: string
    resources: {
      skills: Array<{ name: string; path: string }>
      agents: Array<{ name: string; path: string }>
      workflows: Array<{ name: string; path: string }>
    }
    setup?: string
    lastUpdated: string
  }
}
```

### DELETE /api/resources/source/:name

```typescript
// Response
interface SourceRemoveResponse {
  data: {
    name: string
    removed: boolean
    installedResources: number   // 未卸载的已安装资源数
  }
}

// 流程:
// 1. 从 allowlist 移除
// 2. 清理 cache/sources/{name}/
// 3. 从 registry 移除 source entry（保留 resource entries 的已安装状态）
// 4. AuditLogger.log("source.removed")
```

## 5.5 中间件

### CORS

```typescript
// packages/server/src/routes/resource/middleware.ts

export async function resourceCors(c: Context, next: Next) {
  const origin = c.req.header("Origin") ?? ""
  if (origin && isTrustedOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Access-Control-Allow-Methods", "GET, POST")
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Octopus-Org")
  }
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204)
  }
  return next()
}
```

仅信任 `localhost` 和 `127.0.0.1`。

### Content-Type 强制

```typescript
export async function requireJsonBody(c: Context, next: Next) {
  if (c.req.method === "POST") {
    const ct = c.req.header("Content-Type")
    if (!requireJsonContentType(ct)) {
      return c.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "..." } }, 415)
    }
  }
  return next()
}
```

## 5.6 Server 注册

```typescript
// packages/server/src/index.ts

import { createResourceRoutes } from "./routes/resource"
import { ResourceManager, BuiltinProvider, LocalProvider } from "@octopus/shared"

// Per-Org 单例
const resourceManagerCache = new Map<string, ResourceManager>()
function getResourceManager(org: string): ResourceManager {
  // ... 创建或返回缓存
}

// 路由注册
app.route("/api/resources", createResourceRoutes(() => {
  return getResourceManager(process.env.OCTOPUS_ORG ?? "default")
}))
```

## 5.7 错误响应格式

所有错误响应统一格式：

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource 'skill/brainstorming' not found",
    "hint": "Ensure the resource is registered. Run 'octopus resource install' first."
  }
}
```

`code` 对应 `ResourceError` 的 20 种错误码，`hint` 来自 `ERROR_CODE_MAP` 的 `suggestion` 字段。

非 `ResourceError` 的未知错误返回泛化消息，不泄漏 stack trace：

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```
