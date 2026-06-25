# Octopus 多实例隔离开发环境 — 方案设计

> **版本**: 2.0.0 | **日期**: 2026-05-27 | **状态**: 实现就绪

---

## 1. 背景与问题

### 1.1 当前痛点

Octopus 是单机开发项目。开发者通过 `git worktree` 在不同分支上并行开发和测试，但共享资源频繁冲突：

| 冲突类型 | 现状 | 后果 |
|----------|------|------|
| **端口冲突** | Server 固定 3001，Web-app 固定 3000 | 第二个实例无法启动；predev 脚本误杀其他分支进程 |
| **数据库冲突** | 全局共享 `~/.octopus/db/octopus.db`，WAL 模式仅允许单写入者 | 两个 Server 实例同时写 → `SQLITE_BUSY` 或数据损坏 |
| **构建互相影响** | `tsup` 编译到同个 `dist/` | 分支间源码不一致导致行为混乱 |
| **CLI 端口硬编码** | `workspace-cmd.ts` 5 处写死 `http://localhost:3001` | CLI 无法连接到非默认端口的 Server |

### 1.2 目标

- **独立环境** — 每个 worktree 拥有完全隔离的运行环境（端口 / DB / 进程）
- **动态端口** — 端口不写死，由分支名确定性推导，不依赖人工协调
- **跨平台** — Windows 11 + macOS，一套方案统一兼容
- **零手动配置** — 一条命令启动，其余自动完成

### 1.3 为什么不用容器

评估了 Docker Compose / Podman / VS Code Dev Container 三种容器方案后，结论是 **不适用日常开发**：

- **macOS bind mount 性能差** — `pnpm install` 在 Docker Desktop 上需要 2-3 分钟（原生 20 秒），每天都在消耗开发效率
- **SQLite WAL 在 VM 边界上不可靠** — `flock` 和 `mmap` 经过 VirtioFS 传递时语义不完整，可能导致 `SQLITE_BUSY` 或数据损坏
- **Docker Desktop 内存开销 1-2 GB** — 每个分支一个容器，5 个分支 = 5-10 GB
- **项目已有 80% 基础设施** — git worktree 隔离、`port-utils.ts` 动态端口检测、测试 DB 临时路径，容器化重复造轮子

容器仅在 CI 中保留：一个简单的 `Dockerfile` 做一次性构建 + 测试。

---

## 2. 方案概述

**纯 Node.js 进程隔离**，在现有 git worktree 工作流基础上，补齐自动端口分配、数据库隔离和 CLI 联动。

### 2.1 隔离原理

```
主仓库 (octopus/main)
├── .git/                          ← 目录
├── packages/
├── pnpm dev  → 默认模式
│   ├── Server: 3001
│   ├── Web:    3000
│   ├── DB:     ~/.octopus/db/octopus.db
│   └── Predev: kill 3001/3000 残留进程

.worktrees/feat-token-stat/
├── .git                           ← 文件（指向主仓库 .git）
├── packages/
├── pnpm dev  → 隔离模式（自动检测）
│   ├── Server: 3242 (hash)
│   ├── Web:    3243 (server+1)
│   ├── DB:     ~/.octopus/db/octopus-feat-token-stat.db
│   └── 直接启动，绕过 predev

.worktrees/fix-bug/
├── .git                           ← 文件
├── packages/
├── pnpm dev  → 隔离模式（自动检测）
│   ├── Server: 3158 (hash)
│   ├── Web:    3159 (server+1)
│   ├── DB:     ~/.octopus/db/octopus-fix-bug.db
│   └── 直接启动，绕过 predev
```

### 2.2 自动检测机制

```javascript
// scripts/dev.mjs 核心逻辑
const isWorktree = fs.statSync(path.join(repoRoot, ".git")).isFile()
// .git 是目录 → 主仓库 → 默认端口 3001/3000
// .git 是文件 → worktree → hash 端口
```

### 2.3 CLI 联动

```
CLI workflow run       → 纯本地执行 (import WorkflowEngine)，不连 Server
CLI workspace list     → 需要连 Server，读取 OCTOPUS_SERVER_URL 环境变量
```

---

## 3. 端口分配方案

### 3.1 Hash 算法

```javascript
// 确定性：同一分支永远得到同一端口
// 范围: 3100 ~ 3598 (250 对端口)
// server 端口为偶数，web 端口为奇数，互不干扰
function branchPort(branch) {
  const hash = crypto.createHash("sha1").update(branch).digest()
  const offset = hash.readUInt16BE(0) % 250  // 0 ~ 249
  const server = 3100 + offset * 2           // 3100, 3102, 3104, ..., 3598
  const web = server + 1                     // 3101, 3103, 3105, ..., 3599
  return { server, web }
}
```

**为什么用偶数偏移**：如果直接 `3001 + hash % 500`，实例 A 的 server=3500 时 web=3501，可能与实例 B 的 server=3501 碰撞。偶数偏移确保 server 永远是偶数，web 永远是奇数，互不干扰。

### 3.2 端口持久化

Hash 碰撞或手动覆盖时，分配的端口需要持久化以避免每次重启都重新扫描：

```
~/.octopus/ports/{branch-safe}.json
```

内容：
```json
{
  "branch": "feat-token-stat",
  "server": 3242,
  "web": 3243,
  "allocatedAt": "2026-05-27T10:00:00Z"
}
```

读取优先级：
```
1. 已有 ports/{branch}.json 且端口空闲 → 直接使用
2. Hash 计算端口未被占用 → 使用并写入 JSON
3. Hash 端口被占用 → 扫描下一个偶数偏移，使用并写入 JSON
```

### 3.3 兜底扫描

```javascript
function allocatePorts(branch) {
  // 1. 检查持久化
  const persisted = readPortFile(branch)
  if (persisted && !isPortInUse(persisted.server) && !isPortInUse(persisted.web)) {
    return persisted
  }

  // 2. Hash + 扫描
  const baseOffset = hash(branch) % 250
  for (let i = 0; i < 250; i++) {
    const server = 3100 + ((baseOffset + i) % 250) * 2
    const web = server + 1
    if (!isPortInUse(server) && !isPortInUse(web)) {
      const result = { branch, server, web, allocatedAt: new Date().toISOString() }
      writePortFile(branch, result)
      return result
    }
  }
  throw new Error("No available port pairs in range 3100-3599")
}
```

### 3.4 碰撞概率分析

| 并发分支数 | 碰撞概率 | 预期扫描次数 |
|------------|----------|-------------|
| 2 | 0.2% | 1.002 |
| 5 | 1.0% | 1.01 |
| 10 | 4.4% | 1.05 |
| 50 | 92.7% | ~2.5 |

即使 50 个分支并发，平均也只需要 2-3 次重试。端口持久化后碰撞只在首次分配时发生。

---

## 4. 数据库隔离方案

### 4.1 命名规则

```
主仓库:  ~/.octopus/db/octopus.db
Worktree: ~/.octopus/db/octopus-{branch-safe}.db
```

`branch-safe`: 分支名中的 `/` 替换为 `-`（如 `feat/token-stat` → `feat-token-stat`）

### 4.2 初始化策略

```
首次启动某分支：
  检查 octopus-{branch}.db 是否存在
  ├── 不存在 → cp octopus.db → octopus-{branch}.db（一次性初始化）
  └── 存在   → 直接复用（数据持久保留）

每次重启该分支：
  数据都在，不清空
```

**Schema 版本注意事项**：
- 主仓库 DB 的 schema 版本可能与 worktree 代码不一致
- `applySchema()` 只向前迁移（`currentVersion < SCHEMA_VERSION`），不支持降级
- 如果 worktree 代码的 `SCHEMA_VERSION` 高于主仓库 DB → 自动迁移，行为正确
- 如果 worktree 代码的 `SCHEMA_VERSION` 低于 DB（分支代码落后）→ `applySchema()` 不做操作，行为正确（旧代码不碰新表/列）

### 4.3 代码改动：`connection.ts`

当前 `connection.ts` **不读取任何环境变量**，`initDb()` 被调用时不传参数（`const db = initDb()`）。需要新增 `OCTOPUS_DB_PATH` 读取：

```typescript
// packages/server/src/db/connection.ts — getDbPath 新增一行
export function getDbPath(dbPath?: string): string {
  if (dbPath) return dbPath
  if (process.env.OCTOPUS_DB_PATH) return process.env.OCTOPUS_DB_PATH   // ← 新增
  const home = os.homedir()
  const dir = path.join(home, ".octopus", "db")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "octopus.db")
}

// initDb() 不变，index.ts 调用不变
// const db = initDb()  → 内部自动走 getDbPath() → 读取 OCTOPUS_DB_PATH
```

### 4.4 测试 DB 隔离

测试代码已使用 `os.tmpdir() + Date.now()` 创建临时数据库文件，天然隔离。无需改动。

已验证的隔离模式：

| 测试文件 | 临时 DB 命名 |
|---------|-------------|
| `db-connection.test.ts` | `test-octopus-${Date.now()}.db` |
| `execution-service.test.ts` | `test-exec-db-${Date.now()}.db` |
| `workspace-service.test.ts` | `test-ws-svc-${Date.now()}.db` |
| `org-service.test.ts` | `test-org-${Date.now()}.db` |
| `db-schema.test.ts` | `test-schema-${Date.now()}.db` |
| `execution-recovery.test.ts` | `test-recovery-${Date.now()}.db` |
| `git-ops.test.ts` | `mkdtempSync(join(tmpdir(), "git-ops-test-"))` |

---

## 5. 实现计划

### 5.1 改动清单

| # | 文件 | 改动内容 | 复杂度 |
|---|------|---------|--------|
| 1 | `packages/server/src/db/connection.ts` | `getDbPath()` 新增读取 `OCTOPUS_DB_PATH` 环境变量（1 行） | 低 |
| 2 | `packages/cli/src/commands/workspace-cmd.ts` | 新增 `getServerUrl()`，替换 5 处硬编码 | 低 |
| 3 | `packages/web-app/components/workspace/execution-panel.tsx` | 修复空字符串 fallback：`""` → `"http://localhost:3001"` | 低 |
| 4 | `packages/server/src/index.ts` | health 端点增加 mode/branch/dbPath 字段 | 低 |
| 5 | `scripts/branch-port.mjs` | **新文件** — 端口计算 + 持久化 + 扫描 | 中 |
| 6 | `scripts/dev.mjs` | **新文件** — 一键启动脚本（进程管理 + 环境注入） | 中 |
| 7 | `package.json` | 新增 `dev` / `port` 脚本 | 低 |
| 8 | `.gitignore` | 新增 `~/.octopus/ports/` 说明 | 低 |

### 5.2 `package.json` scripts

```json
{
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "port": "node scripts/branch-port.mjs",
    "dev:server": "pnpm --filter @octopus/server dev",
    "dev:web": "pnpm --filter @octopus/web-app dev",
    "kill:server": "node scripts/kill-port.mjs 3001",
    "kill:web": "node scripts/kill-port.mjs 3000"
  }
}
```

- `pnpm dev` → 调用 `dev.mjs`，自动判断模式（default / isolated）
- `pnpm dev:server` / `pnpm dev:web` → 保留原样，仍可单独启动（走 predev 杀默认端口）
- `pnpm port` → 仅查看端口分配，不启动服务

### 5.3 不改动的内容

| 内容 | 原因 |
|------|------|
| `predev` 钩子 | `dev.mjs` 直接 `spawn("node", ["dist/index.js"])` 和 `spawn("npx", ["next", "dev", "-p", PORT])`，不经过 pnpm filter，自然绕过 predev |
| `port-utils.ts` | 保留现有 API，`dev.mjs` 使用自己的 Node.js 版端口检测（避免 import server 包） |
| `scripts/kill-port.mjs` | 保留，仍可通过 `pnpm kill:server` / `pnpm kill:web` 手动清理 |
| 测试代码 | 已天然隔离（tmpdir + Date.now()），无需改动 |
| CLI `workflow run` | 纯本地执行（直接 `import { WorkflowEngine } from "@octopus/engine"`），不连 Server |
| Server `index.ts` 端口逻辑 | 已支持 `--port=` 参数 > `PORT` 环境变量 > 默认 3001 三级回退 |
| Server `index.ts` 的 `initDb()` 调用 | 无需传参，`getDbPath()` 内部自动读取 `OCTOPUS_DB_PATH` |

---

## 6. `dev.mjs` 实现方案

### 6.1 完整流程

```
dev.mjs 启动
  │
  ├── 1. 检测模式
  │   └── fs.statSync(".git").isFile() → worktree / 目录 → 主仓库
  │
  ├── 2. 分配端口
  │   ├── 主仓库 → server=3001, web=3000
  │   └── worktree → 读持久化 → hash → 扫描 → 写持久化
  │
  ├── 3. 初始化 DB（仅 worktree 模式）
  │   └── octopus-{branch}.db 不存在时 fs.copyFileSync(octopus.db, ...)
  │
  ├── 4. 清理残留进程
  │   └── net.createServer() 检测端口 → 占用时 taskkill/lsof 杀进程
  │
  ├── 5. 启动子进程（绕过 predev）
  │   ├── spawn("node", ["packages/server/dist/index.js"], { env })
  │   └── spawn("npx", ["next", "dev", "-p", webPort], { env, cwd: "packages/web-app" })
  │
  ├── 6. 等待 Server 健康检查通过
  │   └── 轮询 GET http://localhost:{serverPort}/api/health，超时 15s
  │
  └── 7. 输出就绪信息，等待 Ctrl+C → cleanup()
```

### 6.2 进程管理

```javascript
// scripts/dev.mjs — 核心进程管理
import { spawn, execSync } from "child_process"
import net from "net"
import path from "path"

const children = []
let shuttingDown = false

function startProcess(cmd, args, env, label) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,  // 关键：不设 detached，否则 Ctrl+C 无法传播
  })

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[${label}] ${line}`)
    }
  })
  child.stderr.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[${label}] ${line}`)
    }
  })

  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`[${label}] Process exited with code ${code}`)
      cleanup(code ?? 1)
    }
  })

  children.push({ child, label })
  return child
}
```

### 6.3 Ctrl+C 传播（跨平台）

Windows 上 `SIGINT` 传播是一个已知坑。之前 `node --watch` 的残留进程问题就是因为 Ctrl+C 只杀了父进程，子进程变成了孤儿。

```javascript
function cleanup(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  console.log("\n[dev] Shutting down...")

  for (const { child, label } of children) {
    if (child.killed) continue

    if (process.platform === "win32") {
      // Windows: taskkill /T 杀进程树，/F 强制
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" })
        console.log(`[${label}] Killed (taskkill /T)`)
      } catch {
        // 进程可能已经退出
      }
    } else {
      // macOS/Linux: SIGTERM 正常传播
      child.kill("SIGTERM")
      console.log(`[${label}] Sent SIGTERM`)
    }
  }

  // 超时强制退出
  setTimeout(() => process.exit(exitCode), 2000)
}

// 捕获 Ctrl+C
process.on("SIGINT", () => cleanup(0))
process.on("SIGTERM", () => cleanup(0))
```

**Windows 关键决策**：
- `detached: false` — 子进程留在同一控制台
- `taskkill /PID /T /F` — `/T` 杀进程树（父子关系），`/F` 强制终止
- 不用 `child.kill("SIGTERM")` — Windows 上 Node.js 的 `kill()` 对子进程不可靠

### 6.4 绕过 predev 的方式

`dev.mjs` **不通过 pnpm** 启动子进程，而是直接调用底层命令：

```javascript
// 启动 Server — 直接调用 node，绕过 pnpm --filter 和 predev
startProcess(
  process.execPath,  // 用当前 node 可执行文件路径
  [path.join(repoRoot, "packages/server/dist/index.js")],
  {
    PORT: String(serverPort),
    OCTOPUS_DB_PATH: dbPath,
    OCTOPUS_BRANCH: isWorktree ? branch : undefined,
  },
  "server"
)

// 启动 Web-app — 直接调用 next dev，绕过 pnpm --filter 和 predev
startProcess(
  "npx",
  ["next", "dev", "-p", String(webPort)],
  {
    NEXT_PUBLIC_SERVER_URL: `http://localhost:${serverPort}`,
  },
  "web"
)
```

**为什么不经过 pnpm**：如果 `dev.mjs` 调用 `pnpm --filter @octopus/server dev`，pnpm 会自动触发 `predev` 钩子（`kill-port.mjs 3001`），误杀主仓库的 Server 进程。直接 `spawn("node", ["dist/index.js"])` 完全绕过 pnpm 的 hook 机制。

### 6.5 健康检查等待

```javascript
async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`)
      if (res.ok) {
        const data = await res.json()
        console.log(`[dev] Server healthy: PID=${data.pid}, mode=${data.mode}`)
        return data
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  console.error(`[dev] Server did not become healthy within ${timeoutMs / 1000}s`)
  cleanup(1)
}
```

### 6.6 DB 初始化

```javascript
function initBranchDb(branch) {
  const safe = branch.replace(/\//g, "-")
  const dbDir = path.join(os.homedir(), ".octopus", "db")
  const mainDb = path.join(dbDir, "octopus.db")
  const branchDb = path.join(dbDir, `octopus-${safe}.db`)

  if (!fs.existsSync(branchDb)) {
    if (fs.existsSync(mainDb)) {
      fs.copyFileSync(mainDb, branchDb)
      console.log(`[dev] DB: copied ${mainDb} → ${branchDb}`)
    } else {
      console.log(`[dev] DB: ${branchDb} will be created fresh on first start`)
    }
  } else {
    console.log(`[dev] DB: reusing ${branchDb}`)
  }

  return branchDb
}
```

---

## 7. 环境变量参考

| 变量 | 作用 | 默认值 | 设置方 | 生效时机 |
|------|------|--------|--------|---------|
| `PORT` | Server HTTP 端口 | 主仓库 3001 / worktree hash | dev.mjs 子进程 env | Server 启动时 |
| `OCTOPUS_DB_PATH` | SQLite 数据库路径 | `~/.octopus/db/octopus.db` | dev.mjs 子进程 env | `initDb()` 调用时 |
| `OCTOPUS_BRANCH` | 当前分支名 | null | dev.mjs 子进程 env | health 端点 |
| `NEXT_PUBLIC_SERVER_URL` | Web-app 后端地址 | `http://localhost:3001` | dev.mjs 子进程 env | Next.js dev 编译时 |
| `OCTOPUS_SERVER_URL` | CLI 连接地址 | `http://localhost:3001` | 用户 shell / dev.mjs | CLI 运行时 |

### 7.1 `NEXT_PUBLIC_SERVER_URL` 的特殊处理

Next.js 的 `NEXT_PUBLIC_*` 变量在 **编译时** 内联到 JS bundle 中：

| 模式 | 行为 | 影响 |
|------|------|------|
| **`next dev`** | 每次请求实时编译 | ✅ 环境变量在启动时读取，每次启动可以不同 |
| **`next build`** | 编译产物中硬编码 | ⚠️ 构建时的值被永久写入 bundle |

**结论**：
- 日常开发用 `next dev`，完全支持动态端口，dev.mjs 设置 env 后启动即可
- 如需 worktree 中 `next build`，需确保环境变量正确：`NEXT_PUBLIC_SERVER_URL=http://localhost:3242 pnpm build:web`
- 生产部署只用主仓库的 build，不受影响

### 7.2 当前 `NEXT_PUBLIC_SERVER_URL` 引用清单

| 文件 | 当前 fallback | 状态 |
|------|-------------|------|
| `lib/api-client.ts` | `?? "http://localhost:3001"` | ✅ 正确 |
| `hooks/use-execution-tree.ts` | `?? "http://localhost:3001"` | ✅ 正确 |
| `lib/ws-client.ts` | `\|\| "http://localhost:3001"` | ✅ 正确 |
| `components/workspace/workflow-detail-panel.tsx` | `\|\| "http://localhost:3001"` | ✅ 正确 |
| `components/workspace/execution-log-viewer.tsx` | `\|\| "http://localhost:3001"` | ✅ 正确 |
| `app/workspaces/[id]/page.tsx` | `\|\| "http://localhost:3001"` | ✅ 正确 |
| `components/workspace/chat/use-chat-stream.ts` | `\|\| "http://localhost:3001"` | ✅ 正确 |
| `components/workspace/execution-panel.tsx` | `\|\| ""` | ⚠️ **Bug：需修复** |

`execution-panel.tsx` 使用空字符串 `""` 做 fallback，意味着未设置环境变量时会请求相对路径（同 host），而 Server 和 Web-app 不在同一端口。需统一为 `?? "http://localhost:3001"`。

---

## 8. Health 端点增强

当前 `/api/health` 返回基础信息（pid, uptime, startedAt, node, port）。增加分支和模式信息：

```typescript
// packages/server/src/index.ts — health 端点
app.get("/api/health", (c) => {
  const dbPath = getDbPath()
  const branch = process.env.OCTOPUS_BRANCH ?? null
  return c.json({
    status: "ok",
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.version,
    port: parseInt(process.env.PORT ?? "3001"),
    mode: branch ? "isolated" : "default",
    branch,
    dbPath,
  })
})
```

`OCTOPUS_BRANCH` 由 `dev.mjs` 在启动 Server 子进程时注入。运维时一眼就能看出这个实例属于哪个 worktree。

---

## 9. 使用手册

### 9.1 前置条件

```bash
# 克隆仓库（仅一次）
git clone https://github.com/XzhiF/octopus.git
cd octopus
pnpm install
pnpm build
```

### 9.2 日常开发（主仓库，单分支）

```bash
pnpm dev

# 输出:
# [dev] mode: default (主仓库)
# [dev] port: server=3001  web=3000
# [dev] db:   ~/.octopus/db/octopus.db
# [server] Octopus Server running on http://localhost:3001 (PID: 12345)
# [web]    ▲ Next.js 16.2.4
# [web]    Local: http://localhost:3000
#
# [dev] Ready. Press Ctrl+C to stop.

# CLI 使用
octopus workflow run ./my-workflow.yaml --org xzf     # 纯本地，无需 server

# Ctrl+C 停止所有服务（server + web-app 一起关闭）
```

### 9.3 多分支并行开发（Worktree）

```bash
# === 终端 1：启动 Worktree A ===
git worktree add .worktrees/feat-token-stat octopus-feat-token-stat
cd .worktrees/feat-token-stat
pnpm install && pnpm build
pnpm dev   # 自动检测 worktree → 隔离模式

# 输出:
# [dev] mode: isolated (worktree)
# [dev] branch: octopus-feat-token-stat
# [dev] port: server=3242  web=3243
# [dev] db:   ~/.octopus/db/octopus-feat-token-stat.db (copied from octopus.db)
# [server] Octopus Server running on http://localhost:3242 (PID: 23456)
# [web]    ▲ Next.js 16.2.4
# [web]    Local: http://localhost:3243
# [dev] Ready. Press Ctrl+C to stop.

# === 终端 2：同时启动 Worktree B ===
git worktree add .worktrees/fix-bug octopus-fix-bug
cd .worktrees/fix-bug
pnpm install && pnpm build
pnpm dev   # 不同的端口！

# 输出:
# [dev] mode: isolated (worktree)
# [dev] branch: octopus-fix-bug
# [dev] port: server=3158  web=3159
# [dev] db:   ~/.octopus/db/octopus-fix-bug.db (copied from octopus.db)
```

### 9.4 运行测试

```bash
# 任何 worktree 中
pnpm test

# 天然隔离:
# - 每个 vitest 进程独立
# - 测试 DB 用 os.tmpdir() + Date.now() 自动隔离
# - 不启动 HTTP Server（VITEST 环境变量保护）
# - 多个 worktree 同时跑测试互不干扰
```

### 9.5 查看当前环境

```bash
pnpm port
# → mode:   isolated
# → branch: octopus-feat-token-stat
# → server: 3242
# → web:    3243

# JSON 格式（便于脚本消费）
pnpm port -- --json
# → {"mode":"isolated","branch":"octopus-feat-token-stat","server":3242,"web":3243}
```

### 9.6 清理

```bash
# 停止（Ctrl+C 即可同时关闭 server + web-app）

# 手动清理残留进程
node scripts/kill-port.mjs 3242
node scripts/kill-port.mjs 3243

# 删除 Worktree
git worktree remove .worktrees/feat-token-stat

# 可选：清理分支 DB 和端口映射
rm ~/.octopus/db/octopus-feat-token-stat.db
rm ~/.octopus/ports/feat-token-stat.json
```

---

## 10. 命令速查表

| 命令 | 场景 | 端口 | DB |
|------|------|------|----|
| `pnpm dev` | 主仓库日常开发 | 3001/3000 | octopus.db |
| `pnpm dev` | worktree 开发 | hash 自动 | octopus-{branch}.db |
| `pnpm dev:server` | 单独启动 Server（走 predev） | 3001 | octopus.db |
| `pnpm dev:web` | 单独启动 Web-app（走 predev） | 3000 | - |
| `pnpm port` | 查看端口分配 | 输出当前端口 | - |
| `pnpm test` | 运行测试 | 不占端口 | 临时 DB |
| `octopus workflow run` | 执行工作流 | 不占端口 | 纯本地 |
| `octopus workspace list` | 管理 workspace | 自动连 server | - |

---

## 11. 验证清单

### 11.1 功能验证

- [ ] 主仓库 `pnpm dev` → 端口 3001/3000，输出 mode: default
- [ ] Worktree `pnpm dev` → 自动检测 worktree，输出 mode: isolated
- [ ] 两个 worktree 同时 `pnpm dev` → 不同端口，不同 DB，互不干扰
- [ ] Worktree DB 不存在时自动从主 DB 拷贝
- [ ] Worktree DB 已存在时直接复用，数据持久
- [ ] `pnpm test` 在两个 worktree 同时运行 → 互不干扰
- [ ] `octopus workflow run` → 纯本地执行，无需 server
- [ ] `octopus workspace list` → CLI 通过 `OCTOPUS_SERVER_URL` 连到正确的 server
- [ ] Ctrl+C 优雅关闭 server + web-app（Windows + macOS 都测试）
- [ ] Ctrl+C 后无残留进程（Windows 用 `tasklist | findstr node` 验证）
- [ ] 端口被占用时自动扫描下一个空闲端口
- [ ] 端口分配持久化到 `~/.octopus/ports/`
- [ ] 重启后复用持久化的端口，不重新扫描
- [ ] `/api/health` 返回 mode、branch、dbPath 信息

### 11.2 跨平台验证

- [ ] Windows 11 (Git Bash) — 全部通过
- [ ] Windows 11 (PowerShell) — 全部通过
- [ ] macOS — 全部通过
- [ ] Windows Ctrl+C → `taskkill /PID /T /F` 杀进程树，无残留
- [ ] macOS Ctrl+C → `SIGTERM` 正常传播，无残留
- [ ] `kill-port.mjs` — `netstat`/`lsof` 双平台

### 11.3 回归验证

- [ ] 现有 `pnpm dev:server` / `pnpm dev:web` 行为不变
- [ ] 现有 `pnpm build` / `pnpm test` 行为不变
- [ ] 现有 `octopus workflow run` 行为不变
- [ ] 现有 `octopus setup` 不受影响

---

## 12. 附录

### 12.1 为什么不用 Docker

| 维度 | Docker Desktop | Podman | 纯 Node.js (本方案) |
|------|---------------|--------|---------------------|
| macOS 文件性能 | 2-3x 慢 | 1.5x 慢 | 原生 |
| Windows 体验 | 需要 WSL2 | WSL2，不够成熟 | 原生 |
| 内存开销（每分支） | 1-2 GB | 300-500 MB | 0 |
| SQLite WAL 可靠性 | bind mount 有风险 | 同 Docker | 完全可靠 |
| 每分支启动 | 30-60s | 30-60s | <5s |
| pnpm store 共享 | 不共享 | 不共享 | 全局共享 |

### 12.2 容器在 CI 中的保留

生产构建的确定性环境仍使用容器：

```dockerfile
FROM node:22-slim AS builder
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm test
```

### 12.3 Windows Ctrl+C 传播机制

Node.js 在 Windows 上的信号处理与 Unix 有本质区别：

| 场景 | Unix 行为 | Windows 行为 |
|------|----------|-------------|
| `SIGINT` (Ctrl+C) | 发送给前台进程组所有进程 | 只发给控制台进程 |
| 子进程继承 | 自动收到信号 | **不自动收到** |
| `detached: true` | 创建新进程组 | 创建新进程组，但无法通过 Ctrl+C 杀 |
| `taskkill /T /F` | N/A | 杀进程树（父子关系），等效于 Unix 的进程组 |

**本方案的策略**：
- `detached: false`（默认值），子进程留在同一控制台
- 捕获 `SIGINT`，在 cleanup 函数中用 `taskkill /PID /T /F` 杀子进程树
- macOS 上用 `child.kill("SIGTERM")`，正常传播

这就是之前 `node --watch` 残留进程问题的根本原因：`node --watch` fork 了子进程，但 Ctrl+C 只杀了父进程（`--watch` 进程），子进程（`dist/index.js`）没收到信号变成了孤儿。

### 12.4 `.gitignore` 状态

```
# 已存在于 .gitignore:
.worktrees/

# 不需要 gitignore 的（在 ~/.octopus/ 下，不在仓库中）:
# ~/.octopus/ports/
# ~/.octopus/db/octopus-*.db
```

所有新增的文件（`~/.octopus/ports/*.json`、`~/.octopus/db/octopus-{branch}.db`）都在用户 home 目录下，不在 git 仓库中，无需修改 `.gitignore`。
