# 02-scope.md — 范围契约

> **PRD**: prd-001 统一资源管理
> **模式**: strict
> **日期**: 2026-07-07
> **状态**: MVP 裁剪完成

⛔ 不写 OUT-OF-SCOPE 项进入需求发现
⛔ 不把 EXAMPLE-ONLY 当成独立需求展开
✅ creative 模式可以把 EXTENSION-CANDIDATE 写入（需明确标注"扩展项"）

---

## MVP 分类总览

| 分类 | 数量 | 说明 |
|------|------|------|
| IN-SCOPE (MVP) | 25 项 | Phase 1 必须交付 |
| DEFERRED | 37 项 | Phase 2+ 或独立项目 |

---

## IN-SCOPE MVP (25 项)

### 核心库 (9 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | types.ts | P0 | ResourceManifest, RegistryEntry, LockFileEntry Zod Schema |
| 2 | errors.ts | P0 | ResourceError 20 error codes + HTTP status + exit code |
| 3 | utils.ts | P0 | isPathWithinBase, computeContentHash, parseRef, formatBytes |
| 4 | security.ts | P0 | isTrustedOrigin + requireJsonContentType |
| 5 | atomic-store.ts | P0 | AtomicJsonStore<T> 原子写入 + .bak 恢复 |
| 6 | registry.ts | P0 | RegistryStore 内存缓存 + invalidation |
| 7 | lock-manager.ts | P0 | LockManager 读写锁 + 漂移检测 |
| 8 | installer.ts + uninstaller.ts | P0 | 文件安装/卸载 + try/catch cleanup（不含 undo stack） |
| 9 | audit-logger.ts | P0 | JSONL 追加（普通写入，不含链式哈希） |

### Server API (2 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 10 | resource/index.ts | P0 | createResourceRoutes() — 10 REST 端点 |
| 11 | 单例工厂 | P0 | getResourceManager(org) per-org 缓存 |

### CLI 瘦客户端 (2 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 12 | resource.ts | P1 | 8 子命令: list/info/install/uninstall/search/doctor/sync/audit |
| 13 | 路由注册 | P1 | cli/src/index.ts 注册 resourceCmd |

### 存储层 (3 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 14 | registry.json | P0 | ~/.octopus/orgs/{org}/resources/registry.json |
| 15 | resources.lock | P0 | 锁文件 + 漂移检测 |
| 16 | audit.jsonl | P0 | 审计日志 JSONL 追加 |

### 闭环验证 (2 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 17 | post-install verify | P0 | 文件系统验证: 文件到达 + 结构正确 + 注册完成 |
| 18 | orphaned 资源标记 | P1 | doctor 命令检测并报告 orphaned 资源 |

### Provider (2 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 19 | builtin-provider.ts | P0 | core-pack 内置资源发现 |
| 20 | local-provider.ts | P0 | 本地目录复制 |

### Web UI (3 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 21 | 资源列表页 + 详情页 | P1 | /resources + /resources/:type/:name |
| 22 | 审计日志页 | P1 | /resources/audit |
| 23 | 侧边栏导航 | P1 | "资源" 一级导航入口 |

### E2E 验证 (2 项)

| # | 模块 | 优先级 | 说明 |
|---|------|--------|------|
| 24 | 集成测试 | P0 | API + filesystem + audit log 闭环断言 |
| 25 | E2E 截图验证 | P1 | 4 个关键截图: 空状态/有数据/详情/审计 |

---

## DEFERRED (37 项)

### Phase 2 — Source 集合源管理 (9 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-1 | source-manager.ts | SourceManager add/remove/update/list/analyze |
| D-2 | source-discovery.ts | 三层降级: manifest → AI → 约定扫描 |
| D-3 | git-provider.ts | git clone --depth 1 + 缓存管理 |
| D-4 | Server source 路由 | 6 个端点 |
| D-5 | CLI source 子命令 | source add/remove/list/update/analyze/info |
| D-6 | config.yaml trusted | resource_sources.trusted allowlist |
| D-7 | setup 命令执行 | execFileSync + 超时 + 审计 |
| D-8 | octo-source-analyzer skill | AI 分析 README 生成 manifest |
| D-9 | octo-resource-manager skill | CLI 参考手册 |

### Phase 2 — 消费者服务迁移 (6 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-10 | BuiltInWorkflowService 迁移 | 废弃 → ResourceManager.list/get (6 文件 ~100 行) |
| D-11 | OrchestratorService 迁移 | workflow 扫描 → ResourceManager (~20 行) |
| D-12 | Knowledge file-ops 迁移 | workflow 扫描 → ResourceManager (~10 行) |
| D-13 | SkillLoader 完整迁移 | 底层扫描改为 ResourceManager 查询 (~50 行) |
| D-14 | RoleRegistry 迁移 | 目录扫描改为 ResourceManager 查询 (~40 行) |
| D-15 | CLI workflow 命令迁移 | run/list/sync 改为 resource 消费者 (~30 行) |

### Phase 2 — UI 扩展 (4 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-16 | 安装对话框 | install-dialog.tsx 组件测试覆盖 |
| D-17 | 信任管理页 | /resources/trust |
| D-18 | 搜索功能 | 集成测试覆盖，UI 延后 |
| D-19 | 依赖图可视化 | deps-graph.tsx（Phase 1 无依赖关系） |

### Phase 2 — 核心库补充 (5 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-20 | DependencyResolver | DFS + 环检测（Phase 1 零调用方） |
| D-21 | InstallTransaction | undo stack 事务回滚（Phase 1 无多步骤事务） |
| D-22 | GarbageCollector | 孤立缓存清理 |
| D-23 | resource-event.ts | ResourceEvent 类型定义 |
| D-24 | Scope 模型 | user/workspace scope（Phase 1 仅 org） |

### Phase 2 — E2E 基础设施 (2 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-25 | E2E test fixture | Server 生命周期管理 + 端口隔离 + 临时目录 |
| D-26 | 截图 baseline 维护 | CI artifact 上传 + 视觉回归 |

### 独立项目 (4 项)

| 原 # | 模块 | 说明 |
|------|------|------|
| D-27 | npm-provider.ts | npm tarball 下载 + trust 体系 |
| D-28 | SkillLoader.has() API | 消费者可见性查询（迁移完成后补充） |
| D-29 | Layer 2 AI 分析 | 循环依赖，Layer 1+3 覆盖所有已知 source |
| D-30 | DB 索引层 | SQLite 查询索引（文件为主足够 MVP） |

### OUT-OF-SCOPE (7 项)

| 原 # | 模块 | 排除理由 |
|------|------|---------|
| O-1 | 链式哈希审计 | 普通 JSONL 追加足够 MVP，安全收益为零 |
| O-2 | repos 命令替代 | git 仓库管理是独立概念 |
| O-3 | npm publish 式发布 | 只做消费端 |
| O-4 | 资源评级/评论 | 保持简单 |
| O-5 | last_used 追踪 | 无消费者，维护成本 > 收益 |
| O-6 | 多进程协调 | 单进程 Server 足够，per-org 隔离 |
| O-7 | USE 反馈 last_loaded_at | 同 O-5 |
