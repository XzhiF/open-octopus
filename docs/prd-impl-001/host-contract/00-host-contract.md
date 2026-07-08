# 宿主项目契约 — host-contract

> **权威约束文档**：后续所有实现节点必须遵守本契约。
> 基于源码实际扫描（15 个文件），非推测。
> 子文档: `01-architecture.md` (后端详情) | `02-ui-system.md` (前端详情)

---

## 1. Monorepo 结构

```
octopus/
├── packages/
│   ├── shared/       ← @octopus/shared (Zod schemas + 共享类型)
│   ├── providers/    ← @octopus/providers (AI Provider 抽象层)
│   ├── engine/       ← @octopus/engine (7 种执行器 + WorkflowEngine)
│   ├── server/       ← @octopus/server (Hono REST API + SSE + WebSocket)
│   ├── web-app/      ← @octopus/web-app (Next.js 16 前端)
│   ├── cli/          ← octopus (Commander.js CLI)
│   └── core-pack/    ← @octopus/core-pack (skills/agents/templates 资源)
├── scripts/          ← dev.mjs, prod.mjs, branch-port.mjs, kill-port.mjs
├── pnpm-workspace.yaml
└── package.json      ← 单一版本来源: "1.0.0"
```

包间依赖: `shared` ← `providers` ← `engine` ← `server`; `shared` ← `web-app`; `core-pack` 无依赖(纯资源)。

---

## 2. 后端技术栈

| 层 | 技术 | 约束 |
|----|------|------|
| 运行时 | Node.js >= 22 | — |
| HTTP 框架 | **Hono v4** | ⛔ 禁止 Express/Koa/Fastify |
| HTTP 适配器 | `http.createServer()` 手动桥接 | 非标准 `@hono/node-server` serve |
| 数据库 | **SQLite** via better-sqlite3 v12 | 同步 API，WAL 模式 |
| ORM | **无** — 纯 DAO 模式 | ⛔ 禁止引入 Prisma/Drizzle/Knex |
| Schema | `schema.sql` + `SCHEMA_VERSION=25` | `IF NOT EXISTS` 幂等 |
| 校验 | **Zod** (在 @octopus/shared 定义) | 前后端共享 schema |
| 构建 | tsup (ESM + CJS) | — |
| 测试 | Vitest | `process.env.VITEST` 检测测试模式 |

### 路由模式

```typescript
// 必须使用工厂函数 + 依赖注入
export function createXxxRoutes(dao: XxxDAO, service: XxxService): Hono {
  const routes = new Hono()
  routes.get("/", ...)
  return routes
}

// 在 index.ts 中注册
app.route("/api/xxx", createXxxRoutes(dao, service))
```

### DAO 模式

```typescript
// 必须继承 BaseDAO，位于 packages/server/src/db/dao/
export class XxxDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }
  
  // 使用 this.stmt() 缓存预处理语句
  findById(id: string) {
    return this.stmt("SELECT * FROM xxx WHERE id = ?").get(id)
  }
}
```

**注册清单 (缺一不可):**
1. `dao/xxx-dao.ts` — 新建 DAO 类
2. `dao/index.ts` — re-export
3. `server/src/index.ts` — `AllDAOs` 接口 + `createAllDAOs()` + lazy DAO fallback

### 错误响应

```typescript
// 普通 API — errorHandler middleware
return c.json({ error: "message" }, 400)

// Agent API (/api/agent/*)
return c.json({ error: { code: "ERR_CODE", message: "msg" } }, 400)
```

### 关键数值

| 参数 | 值 |
|------|-----|
| Body 大小限制 | 1MB |
| 默认端口 | 3001 (主) / 3100-3598 (worktree hash) |
| Graceful shutdown | 3s 超时 |
| DAO 类总数 | 13 个 |
| Schema 版本 | 25 |

---

## 3. 前端技术栈

| 层 | 技术 | 约束 |
|----|------|------|
| 框架 | **Next.js 16.2** (App Router) | ⛔ 禁止 Pages Router |
| React | **19.2** (RSC 启用) | 需要 hooks → `'use client'` |
| CSS | **Tailwind CSS v4** (oklch 变量) | ⛔ 禁止 CSS Modules/styled-components |
| 组件库 | **shadcn/ui** (new-york) | 57 个基础组件可用 |
| 变体 | **CVA** (class-variance-authority) | 必须用 CVA 定义组件变体 |
| className | **cn()** = clsx + twMerge | 必须用 cn() 合并 className |
| 图标 | **lucide-react** | ⛔ 禁止其他图标库 |
| 状态 | Context + Hooks | ⛔ 禁止 Redux/Zustand/Jotai |
| 表单 | react-hook-form + zod | — |
| HTTP | `apiFetch()` (credentials:include) | cookie 认证 |
| 实时 | WebSocket (chat) + SSE (events) | — |
| 暗色模式 | next-themes + `.dark` class | oklch CSS 变量 |

### API 调用模式

```typescript
// packages/web-app/lib/api-client.ts
import { getServerUrl } from "@/lib/server-config"

export async function fetchXxx() {
  const res = await apiFetch(`${getServerUrl()}/api/xxx`)
  return res.json()
}

export async function createXxx(data: XxxInput) {
  const res = await apiFetch(`${getServerUrl()}/api/xxx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}
```

### 路径别名

`@/components/` | `@/lib/` | `@/hooks/`

---

## 4. 后端约束 (新增资源必须遵守)

### B-1: 表创建

在 `packages/server/src/db/schema.sql` 添加:
```sql
CREATE TABLE IF NOT EXISTS my_table (
  id TEXT PRIMARY KEY,
  ...
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
并递增 `SCHEMA_VERSION` 常量 (`packages/server/src/db/schema.ts`)。

### B-2: DAO 创建

在 `packages/server/src/db/dao/` 创建新 DAO，继承 `BaseDAO`，完成注册清单。

### B-3: 路由创建

使用 `createXxxRoutes()` 工厂函数，在 `server/src/index.ts` 注册到 `app.route()`。

### B-4: Service 层

业务逻辑放 `packages/server/src/services/`，接收 DAO 实例构造。

### B-5: Zod Schema

共享 schema 放 `packages/shared/src/`，通过 `@octopus/shared` 导入。

### B-6: Feature Flag

新功能如需门控，在 `config/feature-flags.ts` 添加 flag，支持 `OCTOPUS_FF_*` 环境变量覆盖。

---

## 5. 前端约束 (新增页面/组件必须遵守)

### F-1: 组件文件

新 UI 组件放 `packages/web-app/components/`，使用 `cn()` + CVA。

### F-2: 页面

新页面放 `packages/web-app/app/` 下对应路由目录，遵循 App Router 约定。

### F-3: Hooks

新 hooks 放 `packages/web-app/hooks/`。

### F-4: 客户端 vs 服务端组件

使用 `useState`/`useEffect`/浏览器 API → 必须 `'use client'` 指令。

### F-5: API 层

在 `packages/web-app/lib/api-client.ts` 中添加新函数，使用 `apiFetch()` + `getServerUrl()`。

### F-6: 表单

使用 react-hook-form + zod resolver，不要手动管理表单状态。

---

## 6. 新增资源 Checklist

每新增一个资源（实体），必须完成以下步骤:

- [ ] `schema.sql` 添加表 (IF NOT EXISTS)，递增 SCHEMA_VERSION
- [ ] `dao/xxx-dao.ts` 创建 DAO 类，继承 BaseDAO
- [ ] `dao/index.ts` re-export
- [ ] `server/src/index.ts` — AllDAOs 接口 + createAllDAOs() + lazyDAO fallback
- [ ] `services/xxx.ts` 创建 Service 类 (如需要)
- [ ] `routes/xxx.ts` 创建路由工厂函数
- [ ] `server/src/index.ts` — app.route() 注册
- [ ] `@octopus/shared` 添加 Zod schema (如需要)
- [ ] `web-app/lib/api-client.ts` 添加 API 函数
- [ ] `web-app/components/` 添加 UI 组件
- [ ] `web-app/app/` 添加页面 (如需要)

---

## 7. 可复用资产

### 后端

| 资产 | 路径 | 用途 |
|------|------|------|
| BaseDAO | `server/src/db/dao/base.ts` | stmt 缓存 + transaction + paginate |
| errorHandler | `server/src/middleware/error.ts` | 全局错误处理 |
| SSEService | `server/src/services/sse.ts` | 实时事件推送 |
| feature-flags | `server/src/config/feature-flags.ts` | 功能门控 |
| lazyDAO | `server/src/index.ts` | 测试模式延迟初始化 |

### 前端

| 资产 | 路径 | 用途 |
|------|------|------|
| cn() | `web-app/lib/utils.ts` | className 合并 |
| apiFetch + handleResponse | `web-app/lib/api-client.ts` | HTTP 请求 |
| getServerUrl() | `web-app/lib/server-config.ts` | Server URL 解析 |
| 57 个 shadcn/ui 组件 | `web-app/components/ui/` | 基础 UI 构建块 |
| 34 个自定义 hooks | `web-app/hooks/` | 业务逻辑复用 |

---

## 8. 构建/测试/启动命令

```bash
# 全局
pnpm install              # 安装依赖
pnpm build                # 构建所有包
pnpm dev                  # 启动开发环境
pnpm test                 # Vitest 测试
pnpm lint                 # ESLint

# 单独包
pnpm build:server         # 构建 server
pnpm dev:server           # 启动 server (端口 3001)
pnpm dev:web              # 启动 web-app (端口 3000)
pnpm build:shared         # 构建 shared (修改 schema 后需要)
```

---

## 9. 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `PORT` | Server 端口 | 3001 |
| `OCTOPUS_DB_PATH` | SQLite 数据库路径 | `~/.octopus/db/octopus.db` |
| `NEXT_PUBLIC_SERVER_URL` | Web-app 后端地址 | `http://localhost:3001` |
| `SERVER_URL` | Web-app 运行时后端地址 (非 NEXT_PUBLIC_) | `http://localhost:3001` |
| `OCTOPUS_FRONTEND_URL` | CORS 允许的前端 URL | — |
| `OCTOPUS_BRANCH` | 当前分支名 (用于隔离模式) | — |
| `OCTOPUS_FF_*` | Feature flag 覆盖 | — |
| `VITEST` | 测试模式标记 | — |

---

## 10. 禁止技术清单 (Hard Blocklist)

| ⛔ 禁止 | 原因 | 替代方案 |
|---------|------|----------|
| Express / Koa / Fastify | 项目用 Hono | 遵循 Hono 路由模式 |
| Prisma / Drizzle / Knex | 无 ORM，纯 DAO | 继承 BaseDAO |
| Redux / Zustand / Jotai | 用 Context + Hooks | React Context + custom hook |
| CSS Modules / styled-components | 用 Tailwind CSS v4 | Tailwind utility classes |
| Pages Router | 用 App Router | `app/` 目录 |
| 其他图标库 | 用 lucide-react | `import { Icon } from 'lucide-react'` |
| 外部状态库 | Context + Hooks 足够 | useState + useContext |
| moment.js | 用 date-fns | `import { format } from 'date-fns'` |

---

## 11. 已知架构风险

实现新功能时需规避的问题:

1. **无全局事务 API** — `BaseDAO.transaction()` 存在但路由层无显式事务包装。涉及多表写入的新功能需手动使用 `dao.transaction(() => { ... })`。
2. **Schema 迁移为手动** — `schema.sql` 仅 `IF NOT EXISTS`，无法删除/修改列。复杂 schema 变更需额外注意兼容性。
3. **Agent Auth 为占位级** — Bearer token 检查存在但无完整密钥验证。安全敏感功能需额外加固。
4. **RSC 边界** — 前端组件使用 hooks 时必须加 `'use client'`，容易遗漏导致构建错误。
5. **双认证机制** — 前端用 cookie (`credentials: "include"`)，Agent API 用 Bearer token — 新功能需明确选择。

---

## 来源

- `01-architecture.md` — 后端架构详情 (architecture-explorer 扫描)
- `02-ui-system.md` — 前端 UI 系统详情 (ui-system-auditor 扫描)
- 直接验证文件: `server/src/index.ts`, `server/src/db/schema.ts`, `server/src/middleware/error.ts`, `web-app/lib/api-client.ts`
