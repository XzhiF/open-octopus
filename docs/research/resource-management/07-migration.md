# 7. 迁移计划

## 7.1 从 PR #12 吸纳的代码

| PR #12 文件 | 目标位置 | 改动 |
|------------|---------|------|
| `shared/src/repository/atomic-store.ts` | `shared/src/resource/atomic-store.ts` | 泛型化 `AtomicJsonStore<T>` + 文件锁 |
| `shared/src/repository/dependency-resolver.ts` | `shared/src/resource/dependency-resolver.ts` | DFS + 环检测 + depth guard |
| `shared/src/repository/errors.ts` | `shared/src/resource/errors.ts` | 改名 RepoError → ResourceError，20 error codes |
| `shared/src/types/resource-manifest.ts` | `shared/src/resource/types.ts` | 合并到 types.ts |
| `shared/src/types/registry.ts` | `shared/src/resource/types.ts` | 合并到 types.ts |
| `shared/src/types/lock-file.ts` | `shared/src/resource/types.ts` | 合并到 types.ts |
| `shared/src/types/audit.ts` | `shared/src/resource/types.ts` | 合并到 types.ts |
| `shared/src/repository/content-hash.ts` | `shared/src/resource/utils.ts` | 合并到 utils.ts |

### 从 PR #12 吸纳但重写的代码

| PR #12 文件 | 目标位置 | 重写理由 |
|------------|---------|---------|
| `cli/src/repository/registry.ts` | `shared/src/resource/registry.ts` | 移到 shared + 加内存缓存 + cache invalidation |
| `cli/src/repository/lock-manager.ts` | `shared/src/resource/lock-manager.ts` | 移到 shared + 漂移检测 |
| `cli/src/repository/installer.ts` | `shared/src/resource/installer.ts` | 移到 shared + isPathWithinBase 安全检查 |
| `cli/src/repository/uninstaller.ts` | `shared/src/resource/uninstaller.ts` | 移到 shared |
| `cli/src/repository/gc.ts` | `shared/src/resource/gc.ts` | 移到 shared |
| `cli/src/repository/audit-logger.ts` | `shared/src/resource/audit-logger.ts` | 移到 shared + 链式哈希 |
| `cli/src/repository/security-context.ts` | `shared/src/resource/security.ts` | 移到 shared + 简化为 isTrustedOrigin |
| `cli/src/repository/providers/*.ts` | `shared/src/resource/providers/` | 移到 shared + 仅保留 builtin + local |
| `cli/src/repository/repository-manager.ts` | `shared/src/resource/manager.ts` | 移到 shared + 重命名为 ResourceManager + undo stack |

## 7.2 丢弃的代码

| PR #12 文件 | 丢弃原因 |
|------------|---------|
| `cli/src/repository/` 整个目录 | 核心逻辑移到 shared，CLI 不再持有 |
| `cli/src/commands/repo.ts` | 重命名为 `resource.ts`（瘦客户端） |
| `cli/src/commands/resources.ts` | 合并到 resource.ts |
| `cli/src/repository/output.ts` | OutputFormatter — CLI 瘦化后不需要，用 chalk 直接格式化 |
| `cli/src/repository/searcher.ts` | 搜索通过 Server API 的 `?query=` 参数实现 |
| `resource/dependency-resolver.ts` (331行 GraphDependencyResolver) | 与 repository/ 版重复，保留后者 |
| `resource/atomic-json-store.ts` (重导出) | 删除重导出，统一到一个位置 |
| `resource/errors.ts` (重导出) | 同上 |

## 7.3 新增的代码

| 文件 | 内容 | 行数 |
|------|------|------|
| `shared/src/resource/install-transaction.ts` | InstallTransaction (undo stack 事务回滚) | ~40 |
| `shared/src/resource/resource-event.ts` | ResourceEvent 类型 (预留扩展) | ~10 |
| `shared/src/resource/providers/types.ts` | SourceProvider 接口 | ~20 |
| `shared/src/resource/providers/builtin-provider.ts` | core-pack 内置资源 (SAFE_NAME_RE + isPathWithinBase) | ~200 |
| `shared/src/resource/providers/local-provider.ts` | 本地目录 (BLOCKED_PREFIXES + SAFE_NAME_RE) | ~100 |
| `server/src/routes/resource/index.ts` | createResourceRoutes() — 10 REST 端点 | ~300 |
| `server/src/routes/resource/middleware.ts` | resourceCors + requireJsonBody | ~30 |
| `server/src/index.ts` (改动) | ResourceManager per-org 单例工厂 | ~35 |
| `cli/src/commands/resource.ts` | 8+6 子命令 (纯 HTTP 客户端) | ~400 |

### Phase 5 新增

| 文件 | 内容 | 行数 |
|------|------|------|
| `shared/src/resource/source-manager.ts` | SourceManager (add/remove/update/list/analyze) | ~250 |
| `shared/src/resource/source-discovery.ts` | 三层降级发现 (manifest → AI → 约定扫描) | ~200 |
| `shared/src/resource/providers/git-provider.ts` | git clone --depth 1 + 缓存管理 | ~150 |
| `core-pack/skills/octo-source-analyzer/SKILL.md` | AI 分析 README 生成 manifest 的 skill | ~100 |
| `core-pack/skills/octo-resource-manager/SKILL.md` | CLI 命令参考手册 skill | ~150 |

## 7.4 实施阶段

### Phase 1: 核心整理（shared 层）

```
1. 创建 shared/src/resource/ 目录
2. 从 PR #12 复制核心文件到 shared/src/resource/
   - atomic-store.ts → 泛型化 AtomicJsonStore<T>
   - dependency-resolver.ts → 直接复用
   - errors.ts → 重命名 + 20 error codes
   - types.ts → 合并所有 Zod Schema
   - utils.ts → 合并 isPathWithinBase + computeContentHash + parseRef + formatBytes
3. 新建模块:
   - registry.ts (RegistryStore + 内存缓存)
   - lock-manager.ts (LockManager + 漂移检测)
   - installer.ts / uninstaller.ts
   - install-transaction.ts (undo stack)
   - audit-logger.ts (链式哈希)
   - gc.ts (GarbageCollector)
   - security.ts (isTrustedOrigin + requireJsonContentType)
   - providers/types.ts + builtin-provider.ts + local-provider.ts
   - manager.ts (ResourceManager 核心编排)
4. 更新 shared/src/index.ts 导出
5. 编写单元测试 (目标: 核心模块 >80% 覆盖)
6. 验证: pnpm build && pnpm test --filter @octopus/shared
```

**预计**: 3-4 小时，~18 文件

### Phase 2: Server API

```
1. 创建 server/src/routes/resource/middleware.ts (CORS + JSON 校验)
2. 创建 server/src/routes/resource/index.ts (10 端点)
3. 在 server/src/index.ts 添加 ResourceManager 单例工厂 + 路由注册
4. 迁移 BuiltInWorkflowService → ResourceManager (6 文件, ~100 行)
5. 迁移 OrchestratorService workflow 扫描 → ResourceManager (~20 行)
6. 迁移 Knowledge file-ops workflow 扫描 → ResourceManager (~10 行)
7. 更新 SkillLoader: 加 Tier 0 workspace 扫描
8. 编写路由测试 (mock ResourceManager)
9. 验证: curl 测试各端点 + pnpm test --filter @octopus/server
```

**预计**: 3-4 小时，~10 文件

### Phase 3: CLI 瘦客户端

```
1. 创建 cli/src/commands/resource.ts (8+6 子命令, 纯 HTTP)
2. 在 cli/src/index.ts 注册 resourceCmd
3. 迁移 CLI workflow 命令:
   - run 支持 resource ref (builtin:prd-impl)
   - list 改为 resource list --type workflow
   - sync 废弃，改为 resource install
4. 删除旧的 cli/src/commands/repo.ts (如果有)
5. 编写 CLI 测试 (mock fetch)
6. 验证: octopus resource list/install/doctor
```

**预计**: 2-3 小时，~3 文件

### Phase 4: Web UI

```
1. 创建 web-app/lib/resource/api.ts (API client)
2. 创建 web-app/hooks/use-resources.ts (React hooks)
3. 创建 web-app/components/resource/ 组件:
   - resource-grid.tsx, filter-tabs.tsx, search-bar.tsx
   - install-dialog.tsx, uninstall-confirm-dialog.tsx
   - dependency-tree.tsx, drift-list.tsx
   - audit-table.tsx, markdown-preview.tsx
4. 创建 web-app/app/resources/ 页面:
   - page.tsx (资源列表)
   - [type]/[name]/page.tsx (资源详情)
   - audit/page.tsx (审计日志)
   - layout.tsx
5. Header 添加"资源"导航 tab
6. 编写 Playwright E2E 测试
7. 验证: 浏览器手动测试
```

**预计**: 4-6 小时，~20 文件

### Phase 5: 集合源管理 + 消费者统一迁移

```
1. 实现 git-provider.ts (git clone --depth 1 + 缓存管理)
2. 实现 source-discovery.ts (三层降级: manifest → AI → 约定扫描)
3. 实现 source-manager.ts (add/remove/update/list/analyze)
4. Server 添加 source 路由 (6 个端点)
5. CLI 添加 source 子命令 (source add/remove/list/update/analyze/info)
6. 更新 config.yaml 添加 resource_sources.trusted
7. 实现 setup 命令执行 (execFileSync + 超时 + 审计)
8. 迁移 SkillLoader: 底层目录扫描改为 ResourceManager 查询 (~50 行)
9. 迁移 RoleRegistry: 目录扫描改为 ResourceManager 查询 (~40 行)
10. core-pack 内置资源启动时自动注册 (BuiltinProvider.list → registry)
11. 更新 SkillLoader 扫描层级 (Tier 1: ~/.claude/skills/, Tier 2: org 级)
12. 创建 octo-source-analyzer skill (AI 分析 README 生成 manifest)
13. 创建 octo-resource-manager skill (CLI 参考手册)
14. 编写 source 相关测试
15. 验证: 用 agency-agents-zh + superpowers-zh + gstack 三个真实 repo 测试
16. 验证: SwarmExecutor 能正确发现 agency-agents-zh 角色
17. 验证: SkillLoader 能正确发现 superpowers-zh skills
```

**预计**: 8-10 小时，~20 文件

### Phase 6: DB 索引层（可选）

## 7.5 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| PR #12 的闭包/路径 bug 带入 | 中 | 中 | Phase 1 逐文件 review |
| SkillLoader 集成断路 | 低 | 高 | 安装后手动验证 skill 加载 |
| Server 单例在多 worker 下不一致 | 低 | 中 | Node.js 单线程，单例安全；多进程需额外协调 |
| CLI 依赖 Server 在线 | 低 | 低 | CLI 提示 "Ensure server is running" 错误 |

## 7.6 成功标准

1. ✅ `octopus resource install builtin:brainstorming` → HTTP → Server → 安装到 workspace
2. ✅ SkillLoader Tier 0 自动发现已安装的 skill
3. ✅ `curl localhost:3001/api/resources` 返回 JSON 列表
4. ✅ Web UI 资源列表页正常显示
5. ✅ Web UI 安装/卸载功能正常
6. ✅ `pnpm test` 全部通过
7. ✅ CLI 文件 < 450 行（瘦客户端 + source 子命令）
8. ✅ Server ResourceManager 单例，无并发冲突
9. ✅ `octopus resource source add git:github.com/jnMetaCode/agency-agents-zh` 成功分析并安装 215 agents
10. ✅ `octopus resource source add git:github.com/jnMetaCode/superpowers-zh` 成功执行 setup 并安装 skills
11. ✅ `octopus resource source add git:github.com/garrytan/gstack` 三层降级正确工作
12. ✅ `octo-source-analyzer` skill 能正确分析 README 并生成 manifest
13. ✅ BuiltInWorkflowService 废弃，`octopus workflow run builtin:prd-impl` 通过 ResourceManager 查找
14. ✅ SwarmExecutor 通过 RoleRegistry → ResourceManager 正确发现 agency-agents-zh 角色
15. ✅ SkillLoader 所有 tier 通过 ResourceManager 查询，无独立目录扫描
