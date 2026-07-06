# 02 — 范围契约

> PRD: prd-001 统一资源管理系统
> 日期: 2026-07-06
> 状态: 待审批

---

## IN-SCOPE（必须交付，100% 完整，无 TODO）

### S1: shared 层核心模块

在 `packages/shared/src/resource/` 中从零构建资源管理核心层。所有 class 必须接受路径注入（不硬编码 `~/.octopus/`）。

| 文件 | 职责 |
|------|------|
| `types.ts` | Zod Schema: ResourceManifest, RegistryEntry, LockFileEntry, SourceRef, ResourceType, InstallPlan |
| `errors.ts` | ResourceError 类（20 种错误码 + 退出码 + 修复建议） |
| `utils.ts` | isPathWithinBase, formatBytes, formatSourceRef, computeContentHash |
| `dependency-resolver.ts` | DFS + 环检测 + depth guard + 拓扑排序 |
| `manager.ts` | ResourceManager（核心编排：install/uninstall/register/list/search/info/gc） |
| `registry.ts` | RegistryStore（registry.json 读写） |
| `installer.ts` | WorkspaceInstaller（从缓存复制到 workspace） |
| `uninstaller.ts` | WorkspaceUninstaller（从 workspace 移除 + 清理 lock） |
| `lock-manager.ts` | LockManager（resources.lock 读写 + 漂移检测） |
| `audit-logger.ts` | AuditLogger（JSONL 追加写入） |
| `gc.ts` | GarbageCollector（扫描未引用缓存） |
| `providers/types.ts` | SourceProvider 接口 |
| `providers/builtin-provider.ts` | 从 core-pack 加载 |
| `providers/local-provider.ts` | 从本地目录加载 |
| `atomic-store.ts` | AtomicJsonStore（原子写入 + .bak 回退） |

**验证标准**: `pnpm build` 通过 + 单元测试覆盖核心路径

### S2: CLI 命令层

`packages/cli/src/resource/` — 仅做 Commander.js 命令绑定，调用 shared 的 ResourceManager。

| 命令 | 说明 |
|------|------|
| `octopus resource install <ref...>` | 安装资源（自动 register + 依赖解析 + 安装到 workspace） |
| `octopus resource uninstall <name>` | 卸载资源 |
| `octopus resource list [--type] [--query]` | 列出资源（含搜索过滤） |
| `octopus resource info <name> [--deps]` | 资源详情（可选显示依赖树） |
| `octopus resource gc [--dry-run]` | 缓存清理 |
| `octopus resource sync [--fix]` | 漂移检测 |
| `octopus resource audit [--last N]` | 审计日志 |
| `octopus resource doctor [--rebuild]` | 自检修复 |

**验证标准**: 每个命令手动执行成功 + 输出正确

### S3: Server API

`packages/server/src/routes/resource/` — 薄路由层，直接调用 shared ResourceManager。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/resources` | GET | 资源列表（支持 type/tag/query/installed 过滤） |
| `/api/resources/:type/:name` | GET | 资源详情 |
| `/api/resources/:type/:name/deps` | GET | 依赖树 |
| `/api/resources/install` | POST | 安装（同步返回结果） |
| `/api/resources/uninstall` | POST | 卸载 |
| `/api/resources/gc` | POST | 缓存清理 |
| `/api/resources/sync` | POST | 漂移检测 + 修复 |
| `/api/resources/audit` | GET | 审计日志 |
| `/api/resources/doctor` | GET | 自检结果 |

**验证标准**: 每个端点 curl 测试成功 + API 测试通过

### S4: Web UI 资源管理页

`packages/web-app/` — 资源管理前端。

| 页面/组件 | 说明 |
|-----------|------|
| 资源列表页 | 卡片列表 + 类型 tab 过滤 + 搜索框 + 安装按钮 |
| 安装对话框 | 来源输入 + 类型选择 + 安装计划预览 + 确认安装 |
| 卸载确认 | 确认对话框 + 调用 API |
| 资源详情页 | 基本信息 + 依赖树 + 反向依赖 + 操作按钮 + SKILL.md 预览 |
| 审计日志页 | 时间线表格 + 过滤 + 导出 JSON |
| Header 导航集成 | `header.tsx` navigation 数组新增 `{ name: "资源", href: "/resources", icon: Package }` |
| API Client | `lib/resource/api.ts` — 所有 API 调用封装 |

**验证标准**: 每个页面浏览器截图证明功能正常

### S5: 集成闭环

资源安装后被现有系统自动发现。

| 接线点 | 改动 |
|--------|------|
| SkillLoader Tier 0 | `server/src/services/agent/skill-loader.ts` 新增 workspace 目录扫描 |
| Pi provider skill 注入 | `providers/src/pi/prompt-enhancer.ts` 从 cwd/.claude/skills/ 读取 |

**验证标准**: 安装 skill 后，Agent 对话中可列出并调用该 skill

### S6: 开发阶段安全策略

| 项目 | 策略 |
|------|------|
| Token/登录/鉴权 | **完全跳过** |
| TrustStore/SecurityContext | **不实现** — 方法签名保留 opts 参数但方法体为空操作 |
| 路径遍历防护 | **保留** — 这是数据完整性，不是安全 |

---

## OUT-OF-SCOPE（明确不做）

| 项目 | 理由 |
|------|------|
| npm/git SourceProvider | source 类型延后到 Phase 4，当前只支持 builtin + local |
| source 类型资源 + VarPool $deps 注入 | 设计风险，延后 |
| SQLite 索引层（完整 FTS5） | 低规模无必要，延后为可选 |
| SSE 安装进度推送 | POST 同步返回即可，安装通常秒级完成 |
| 资源发布（npm publish 式） | 只做消费端 |
| 资源评级/评论 | 保持简单 |
| 资源自动更新 | 手动管理足够 |
| 远程 registry（中心化 registry server） | 使用本地 registry.json |
| 工作流 YAML 中声明资源依赖 | 后续版本考虑 |
| 多 workspace 批量同步 | 当前单 workspace 操作 |
| 资源 marketplace UI | 当前只是本地管理 |

---

## EXAMPLE-ONLY（文档中展示但不作为独立需求）

| 项目 | 出处 | 说明 |
|------|------|------|
| npm tarball 下载流程 | 02-architecture.md | SourceProvider 接口定义，npm 实现延后 |
| git clone --depth 1 流程 | 02-architecture.md | 同上 |
| Agent 门控的 `--confirmed` 标志 | 04-cli.md | 开发阶段 no-op，不展开 |
| TOFU 首次信任确认交互 | 04-cli.md | 开发阶段 no-op，不展开 |
| `$deps.octopus-utils` VarPool 注入 | 02-architecture.md | source 类型延后，不展开 |
| workspace config.json 声明式格式 | 03-storage.md | 当前 config.json 保持 ad-hoc |

---

## EXTENSION-CANDIDATE（扩展项，标注为扩展）

| 扩展项 | 前置条件 | 标注 |
|--------|---------|------|
| 📌 SQLite 索引层 + FTS5 全文搜索 | 资源数 > 1000 或搜索性能瓶颈 | 扩展项 |
| 📌 npm SourceProvider | 社区 skill 发布需求 | 扩展项 |
| 📌 git SourceProvider | GitHub skill 仓库安装需求 | 扩展项 |
| 📌 source 类型 + VarPool $deps 注入 | 工作流引用外部代码库需求 | 扩展项 |
| 📌 资源版本回滚 | skill evolution 频繁出错 | 扩展项 |
| 📌 SSE 安装进度推送 | 大资源安装超时体验问题 | 扩展项 |
| 📌 资源 marketplace（中心化 registry） | 社区规模增长 | 扩展项 |
| 📌 工作流 YAML 资源依赖声明 | 工作流可移植性需求 | 扩展项 |
| 📌 多 workspace 批量同步 | 多项目并行管理需求 | 扩展项 |
| 📌 生产化安全实现（TOFU + Token + RBAC） | 上线前 | 扩展项 |

---

## 范围校验

### 需求数量

| 类别 | 数量 |
|------|------|
| IN-SCOPE 功能需求 | S1-S6 共 6 大模块（S3 端点减至 9，S4 移除信任页+新增 Header 集成） |
| OUT-OF-SCOPE 排除项 | 11 项 |
| EXAMPLE-ONLY 示例项 | 6 项 |
| EXTENSION-CANDIDATE 扩展项 | 10 项 |

### 完整性检查

- ✅ 每个 IN-SCOPE 项有明确的验证标准
- ✅ OUT-OF-SCOPE 项不写入需求发现
- ✅ EXAMPLE-ONLY 项不作为独立需求展开
- ✅ EXTENSION-CANDIDATE 明确标注「扩展项」
- ✅ 开发阶段安全策略边界清晰（TrustStore/SecurityContext 不实现）
- ✅ PR #12 引用已全部清除（greenfield 项目）
- ✅ Web UI 基于实际 Header 导航设计
