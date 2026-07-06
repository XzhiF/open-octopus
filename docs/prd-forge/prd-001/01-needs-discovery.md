# 01 — 需求发现综合报告

> PRD Forge Swarm #001 · server-resource-manager
> 综合日期: 2026-07-06
> 参与专家: product-manager / domain-analyst / devil-advocate
> 综合者: Host Agent

---

## 1. 问题陈述

Octopus 平台缺少统一资源管理系统。skill/agent/workflow 三类资源的安装、发现、生命周期管理分散在手工脚本和目录约定中：

- **安装成本高**: 每次 5-10 分钟手动 git clone → 找目录 → 复制文件 → 祈祷路径对
- **Server 断层**: CLI-only 管理，Web UI 和 Server API 无法触及资源，平台不完整
- **无生命周期管理**: 无审计、无漂移检测、无依赖解析、无版本追溯
- **双轨代码**: PR #12 的 `repository/` vs `resource/` 设计已存在分歧，不统一将持续恶化

## 2. 问题证据

| 证据 | 来源 | 结论 |
|------|------|------|
| shared/src/ 中 grep ResourceManager/RegistryStore/SourceProvider 0 匹配 | 代码验证 | PR #12 代码不存在，这是 greenfield |
| web-app header.tsx 导航: `[Dashboard, 工作空间, 系统调度, Agent]` | 代码验证 | 无 AppSidebar，资源入口须加到 header navigation 数组 |
| shared/src/ 有 136 处 fs 操作（11 个文件） | grep 统计 | shared 非纯函数包，repo-ops/manifest/plugin 已有 fs 先例 |
| `repository/` 仅出现在设计文档中，源码 0 匹配 | 代码验证 | 无遗留代码可吸纳 |
| 用户原始 idea: "CLI 端实现 resource 有弊端，应该在 server 端" | 用户输入 | Server-First 方向已确认 |

## 3. 目标用户

- **主要**: Octopus 平台开发者（3-5 人，CLI + Web UI 双重入口）
- **次要**: Agent 运行时（通过 Server API 在工作流执行中编程式安装资源）

## 4. 机会假设

Server-First 架构 + 安装即可发现（闭环集成）= 开发者体验从"手动折腾"变为"一键安装"。Web UI 管理 CLI 工具资源是 Octopus 相对 Cursor/Cline 的差异化优势。

## 5. 不做的代价

- 每次 skill 安装浪费 5-10 分钟
- Server/Web UI 永远缺少资源管理模块
- 与 Cursor/Cline 体验差距拉大
- PR #12 方向的双轨设计分歧持续存在

---

## 6. 对抗质疑回应

### 🔴 C1: PR #12 代码不存在 → **采纳，修正为 greenfield**

grep 全仓库 0 匹配。这是纯 greenfield 项目。

**修正**: 删除所有"从 PR #12 吸纳"表述。迁移计划的"复制+重构"改为"设计+实现"。~34 文件 ~3800 行估算保留作参考，但步骤从零编写。

### 🔴 C2: "文件为主 DB 为辅"自相矛盾 → **折中方案**

Web UI 搜索/审计过滤/依赖图确实需要高效查询。但"让 SQLite 做主存储"丢弃了 JSON 的人类可读性和 git 可追踪性。

**决策**: **双引擎分工**——registry.json 是 source of truth（持久化 + 可读性 + git 友好），SQLite 是 Server 的运行时查询引擎（非可选）。Server 启动时从 JSON 重建 SQLite。消除双写一致性问题。

### 🔴 C3: shared 变 God Package → **驳回**

grep 证实 shared 已有 136 处 fs 操作（repo-ops git clone/文件扫描，manifest JSON 读写，plugin 目录探测）。shared **从来不是纯函数包**。ResourceManager 是合理延续。

**约束**: 所有 class 必须接受路径注入（不硬编码 `~/.octopus/`），确保 worktree/dev/prod 三种模式正确运行。记录 ADR。

### 🟡 R1: Web UI 假设不存在的导航壳 → **采纳**

代码确认: header.tsx 顶部 4 tab，无全局 sidebar。

**决策**: 资源入口 = header navigation 数组新增 `{ name: "资源", href: "/resources", icon: Package }`。所有基于 sidebar 的线框图废弃。

### 🟡 R2: CLI 命令膨胀 → **部分采纳**

用户要求 100% 完整，但合并是设计优化非功能删减。

**决策**: 8 个命令（install/uninstall/list/info/gc/sync/audit/doctor）。install 内含 register，list 支持 --filter，info 支持 --deps，init 改惰性初始化。

### 🟡 R3: source 资源类型与 repos 重叠 → **采纳，降级**

source 无 SkillLoader 消费者，$deps.* 仅 bash 节点可用，`octopus repos clone` 已覆盖 git clone。

**决策**: Phase 1 实现 skill/agent/workflow 三种类型。source 保留在 Schema 定义中（类型完整），Installer/Provider/闭环集成延后。

### 🟡 R4: 闭环集成 70 行估算低估 → **采纳**

SkillLoader 是单例，Engine.ts 是最大文件之一。

**决策**: 闭环集成给独立 Phase，独立测试，估算上修到 ~300 行。

### 🔵 Q1: "不要安全"但 TrustStore 在 scope → **明确定义**

**决策**: TrustStore/SecurityContext 模块**不实现**。方法签名保留 opts 参数但方法体为空操作。信任管理页从 IN-SCOPE 移除。后续加安全只需填充方法体 + 加 middleware。

### 🔵 Q2: "100% 完整"边界 → **明确定义**

**决策**: 完整 = 每个 IN-SCOPE 项的 happy path + 主要 error path（网络超时、文件不存在、格式异常）。不含 edge case 穷举（并发安装锁、离线模式、资源签名）。

### 🔵 Q3: 工时估算低估 → **采纳**

**决策**: 重估为单人全职 2-3 天。Phase 4 测试嵌入各 Phase 而非独立。

---

## 7. 范围调整汇总

| 变更 | 原范围 | 修正后 |
|------|--------|--------|
| CLI 命令 | 12 子命令 | 8 子命令（合并 register/search/deps/init） |
| 资源类型 | 4 类全部 Phase 1 | skill/agent/workflow Phase 1，source 扩展项 |
| 存储架构 | SQLite 可选 | SQLite 是 Server 运行时查询引擎，JSON 仍是 source of truth |
| 信任管理页 | IN-SCOPE | 移除（不要安全的推论） |
| 新增 | — | S-25: Header 导航集成 |
| 闭环集成 | 嵌入 Phase 1 | 独立 Phase，估算 ~300 行 |
| 工作估算 | 11-16 小时 | 2-3 天（单人全职） |

## 8. Phase 划分

| Phase | 内容 | 估算 |
|-------|------|------|
| **1a** | shared/resource 核心层（types + Manager + Store + Provider×2 + Resolver + Lock + Audit + Installer） | 1 天 |
| **1b** | CLI 8 子命令 + 闭环集成（SkillLoader Tier 0 / Prompt Enhancer） | 0.5 天 |
| **2** | Server API 8-10 端点 + ResourceService + SQLite 索引层 | 0.5 天 |
| **3** | Web UI（列表/安装/详情/审计 4 页面 + Header 导航 + API client） | 0.5-1 天 |
| **测试** | 单元测试 ≥80% + UI 截图验证 | 嵌入各 Phase |

---

```json
{"assessment": {"consensus_score": 0.85, "should_continue": true, "reason": "三位专家在核心架构调整（Server-First/shared提升/Header导航/greenfield实现）上高度一致。魔鬼代言人的3个CRITICAL质疑中2个被代码证据证实采纳（PR#12不存在、存储架构折中），1个被驳回但有约束（shared非God Package但需路径注入）。范围调整清晰，Phase划分合理，可进入PRD细化。"}}
```
