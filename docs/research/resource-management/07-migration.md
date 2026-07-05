# 7. 迁移计划

## 7.1 从 PR #12 吸纳的代码

| PR #12 文件 | 目标位置 | 改动 |
|------------|---------|------|
| `cli/src/repository/security-context.ts` | `cli/src/resource/security.ts` | 重命名 + 消除 @ts-expect-error |
| `cli/src/repository/providers/*.ts` | `cli/src/resource/providers/*.ts` | 直接复用 |
| `cli/src/repository/registry.ts` | `cli/src/resource/registry.ts` | 直接复用 |
| `cli/src/repository/installer.ts` | `cli/src/resource/installer.ts` | 直接复用 |
| `cli/src/repository/uninstaller.ts` | `cli/src/resource/uninstaller.ts` | 直接复用 |
| `cli/src/repository/gc.ts` | `cli/src/resource/gc.ts` | 直接复用 |
| `cli/src/repository/lock-manager.ts` | `cli/src/resource/lock-manager.ts` | 直接复用 |
| `cli/src/repository/audit-logger.ts` | `cli/src/resource/audit-logger.ts` | 直接复用 |
| `cli/src/repository/output.ts` | `cli/src/resource/output.ts` | 直接复用 |
| `cli/src/repository/searcher.ts` | `cli/src/resource/searcher.ts` | 直接复用 |
| `cli/src/repository/repository-manager.ts` | `cli/src/resource/manager.ts` | 重命名 + 重构 |
| `shared/src/repository/atomic-store.ts` | `shared/src/resource/atomic-store.ts` | 直接复用 |
| `shared/src/repository/content-hash.ts` | `shared/src/resource/content-hash.ts` | 合并到 utils.ts |
| `shared/src/repository/dependency-resolver.ts` | `shared/src/resource/dependency-resolver.ts` | 直接复用 |
| `shared/src/repository/errors.ts` | `shared/src/resource/errors.ts` | 改名 RepoError → ResourceError |
| `shared/src/types/resource-manifest.ts` | 保留 | 直接复用 |
| `shared/src/types/registry.ts` | 保留 | 直接复用 |
| `shared/src/types/lock-file.ts` | 保留 | 直接复用 |
| `shared/src/types/trusted-sources.ts` | 保留 | 直接复用 |
| `shared/src/types/audit.ts` | 保留 | 重命名避免冲突 |
| `core-pack/skills/resource-management/` | 保留 | 更新为 resource 命令 |

## 7.2 丢弃的代码

| PR #12 文件 | 丢弃原因 |
|------------|---------|
| `cli/src/repository/` 目录本身 | 重命名为 `cli/src/resource/` |
| `shared/src/repository/` 目录 | 合并到 `shared/src/resource/`，消除双轨 |
| `resource/dependency-resolver.ts` (331行 GraphDependencyResolver) | 与 repository/ 版重复，保留后者 |
| `resource/atomic-json-store.ts` (重导出) | 删除重导出，统一到一个位置 |
| `resource/errors.ts` (重导出) | 同上 |
| `cli/src/commands/repo.ts` | 重命名为 `cli/src/commands/resource.ts` |
| `cli/src/commands/resources.ts` | 合并到 resource.ts |

## 7.3 新增的代码

| 文件 | 内容 |
|------|------|
| `server/src/services/resource/resource-service.ts` | ResourceManager 的 server 层包装 |
| `server/src/routes/resource/*.ts` | REST API 端点（8 个路由文件） |
| `web-app/components/resource/*.tsx` | UI 组件（8 个组件文件） |
| `web-app/lib/resource/api.ts` | API client |
| DB schema + 同步逻辑 | SQLite 索引层（可选） |

## 7.4 实施阶段

### Phase 1: 核心整理（从 PR #12 吸纳 + 重构）

```
1. 创建 cli/src/resource/ 目录
2. 从 PR #12 复制核心文件，重命名 repository → resource
3. 合并 shared/src/repository/ 到 shared/src/resource/
4. 删除双轨重复代码
5. 创建 cli/src/commands/resource.ts（从 repo.ts 重命名）
6. 更新测试路径
7. 验证: pnpm build && pnpm test
```

**预计**: 2-3 小时，~30 文件

### Phase 2: Server API

```
1. 创建 server/src/services/resource/resource-service.ts
2. 创建 server/src/routes/resource/ 路由
3. 在 server/src/index.ts 注册路由
4. 添加 API 测试
5. 验证: curl 测试各端点
```

**预计**: 3-4 小时，~10 文件

### Phase 3: Web UI

```
1. 创建 web-app/components/resource/ 组件
2. 创建 web-app/lib/resource/api.ts
3. 在 AgentTabs 中添加 "资源" tab
4. 实现资源列表 + 搜索 + 安装 + 详情 + 审计
5. 验证: 浏览器手动测试
```

**预计**: 4-6 小时，~10 文件

### Phase 4: DB 索引层（可选）

```
1. 创建 resources.db schema
2. 在 RegistryStore 添加 DB 同步逻辑
3. 在 server 查询层使用 DB（搜索 + 列表）
4. 实现 octopus resource doctor --rebuild-db
5. 验证: DB 与文件一致性测试
```

**预计**: 2-3 小时，~5 文件

## 7.5 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| PR #12 的闭包/路径 bug 带入 | 中 | 中 | Phase 1 逐文件 review |
| SkillLoader 集成断路 | 低 | 高 | 安装后手动验证 skill 加载 |
| CORS 影响新路由 | 低 | 低 | PR #12 已修复 CORS |
| DB 同步与文件不一致 | 中 | 低 | doctor --rebuild-db 可恢复 |

## 7.6 成功标准

1. ✅ `octopus resource register builtin:brainstorming --type skill` 成功注册
2. ✅ `octopus resource install brainstorming` 安装到 workspace
3. ✅ SkillLoader 自动发现已安装的 skill
4. ✅ `curl localhost:3001/api/resources` 返回 JSON 列表
5. ✅ Web UI 资源列表页正常显示
6. ✅ Web UI 安装对话框功能正常
7. ✅ `pnpm test` 全部通过
