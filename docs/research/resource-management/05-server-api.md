# 5. Server API 设计

## 5.1 路由概览

所有路由前缀: `/api/resources`

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| GET | `/` | 资源列表 | 公开 |
| GET | `/search?q=<query>` | 搜索资源 | 公开 |
| GET | `/:type/:name` | 资源详情 | 公开 |
| GET | `/:type/:name/deps` | 依赖树 | 公开 |
| POST | `/register` | 注册资源 | human only |
| POST | `/install` | 安装到 workspace | human + agent |
| POST | `/uninstall` | 从 workspace 卸载 | human + agent |
| POST | `/gc` | 清理缓存 | human only |
| POST | `/sync` | 检测/修复漂移 | human + agent |
| GET | `/audit` | 审计日志 | 公开 |
| GET | `/trust` | 信任来源列表 | 公开 |
| POST | `/trust` | 添加/移除信任 | human only |
| GET | `/doctor` | 自检 | 公开 |

## 5.2 端点详细设计

### GET /api/resources

```typescript
// Query params
interface ListQuery {
  type?: 'skill' | 'agent' | 'workflow'  // 过滤类型
  tag?: string                            // 过滤标签
  installed?: boolean                     // 仅已安装
  workspace?: string                      // workspace 路径（installed=true 时需要）
}

// Response
interface ListResponse {
  resources: ResourceEntry[]
  total: number
  by_type: { skill: number; agent: number; workflow: number }
}
```

### POST /api/resources/install

```typescript
// Request
interface InstallRequest {
  names: string[]                    // 要安装的资源名
  workspace: string                  // 目标 workspace 路径
  dry_run?: boolean                  // 仅返回安装计划
  confirmed?: boolean                // Agent 确认标志
}

// Response
interface InstallResponse {
  plan: {
    ordered: Array<{ name: string; type: string }>
    skipped: string[]
  }
  results?: Array<{
    name: string
    status: 'success' | 'failed' | 'skipped'
    target?: string
    reason?: string
  }>
  lock_file?: string                 // resources.lock 路径
}
```

### POST /api/resources/register

```typescript
// Request
interface RegisterRequest {
  ref: string                        // "npm:xxx" | "github:xxx" | "builtin:xxx" | "./path"
  type: 'skill' | 'agent' | 'workflow'
  name?: string                      // 自定义名称
  tags?: string[]
  force?: boolean
  trust?: boolean                    // 自动信任来源
}

// Response
interface RegisterResponse {
  entry: RegistryEntry
  trust_status: 'trusted' | 'newly_trusted' | 'blocked'
}
```

### GET /api/resources/audit

```typescript
// Query params
interface AuditQuery {
  last?: number                      // 返回最近 N 条（默认 20）
  action?: string                    // 按动作过滤
  resource_name?: string             // 按资源名过滤
}

// Response
interface AuditResponse {
  entries: AuditEntry[]
  total: number
}
```

### GET /api/resources/:type/:name/deps

```typescript
// Response
interface DepsResponse {
  name: string
  type: string
  dependencies: Array<{
    name: string
    type: string
    optional: boolean
    installed: boolean
  }>
  reverse_deps: Array<{              // 谁依赖了我
    name: string
    type: string
  }>
  graph: {                           // 完整依赖图（可选）
    nodes: Array<{ name: string; type: string }>
    edges: Array<{ from: string; to: string }>
  }
}
```

## 5.3 SSE 推送

安装操作可能耗时较长（下载 + 解压），通过 SSE 推送进度：

```typescript
// POST /api/resources/install 返回 SSE stream
event: install_progress
data: {"step":1,"total":3,"name":"brainstorming","status":"installing"}

event: install_progress
data: {"step":1,"total":3,"name":"brainstorming","status":"success","target":".claude/skills/brainstorming"}

event: install_progress
data: {"step":2,"total":3,"name":"tdd-workflow","status":"installing"}

event: install_complete
data: {"installed":3,"failed":0,"skipped":0}
```

## 5.4 Service 层实现

```typescript
// packages/server/src/services/resource/resource-service.ts

export class ResourceService {
  private manager: ResourceManager

  constructor(resourcesDir: string) {
    this.manager = new ResourceManager(resourcesDir)
  }

  // 直接代理 ResourceManager 的方法
  list(opts?: ListOptions): ResourceEntry[] {
    return this.manager.list(opts?.type)
  }

  async install(names: string[], workspace: string, opts?: InstallOptions): Promise<InstallResult> {
    return this.manager.install(names, workspace, opts)
  }

  async register(ref: SourceRef, type: ResourceType, opts?: RegisterOptions): Promise<RegistryEntry> {
    return this.manager.register(ref, type, opts)
  }

  // ... 其他方法同理
}
```

Server 在启动时创建 `ResourceService` 单例：

```typescript
// packages/server/src/index.ts
const resourceService = new ResourceService(
  path.join(os.homedir(), '.octopus', 'resources')
)
```
