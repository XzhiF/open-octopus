# 6. Web UI 设计

## 6.1 页面结构

在现有 AgentTabs 中新增一个 "资源" tab：

```
AgentTabs:
  对话 | 记忆 | 知识 | SKILL | 资源 | 分身 | 任务
                              ▲ 新增
```

### 资源 Tab 内部页面

```
/resources
├── /                        # 资源列表（默认页）
├── /search?q=xxx           # 搜索结果
├── /:type/:name            # 资源详情
├── /install                # 安装对话框
├── /trust                  # 信任管理
└── /audit                  # 审计日志
```

## 6.2 资源列表页

```
┌──────────────────────────────────────────────────────────┐
│  资源管理                                     [安装资源]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  [全部] [Skills(3)] [Agents(1)] [Workflows(2)]           │
│                                                          │
│  搜索: [________________] 🔍                             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 🧠 brainstorming           skill    v1.2.0        │  │
│  │    在任何创造性工作之前进行需求分析和设计探索        │  │
│  │    npm:superpowers-zh · 4.0 KB · [design] [plan]  │  │
│  │                              [卸载] [详情] [依赖]  │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ 📋 tdd-workflow             skill    v0.5.0        │  │
│  │    测试驱动开发工作流                               │  │
│  │    builtin · 2.1 KB · [testing]                    │  │
│  │                              [卸载] [详情] [依赖]  │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ 🔍 code-reviewer            agent    v1.0.0        │  │
│  │    代码审查专家                                     │  │
│  │    github:XzhiF/agents · 3.5 KB                    │  │
│  │                              [卸载] [详情] [依赖]  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  共 4 个资源 (3 skills, 1 agent)                         │
└──────────────────────────────────────────────────────────┘
```

## 6.3 安装对话框

```
┌──────────────────────────────────────────────────────┐
│  安装资源                                       [×]  │
├──────────────────────────────────────────────────────┤
│                                                      │
│  来源: [npm:superpowers-zh________] [验证]           │
│                                                      │
│  类型: [skill ▾]                                     │
│  名称: [brainstorming________] (自动推断)            │
│  标签: [design, planning________]                    │
│                                                      │
│  ☑ 信任此来源 (TOFU)                                 │
│                                                      │
│  ── 安装计划 ──                                      │
│  1. skill:brainstorming  ← will install              │
│  2. skill:tdd-workflow   ← dependency, will install  │
│                                                      │
│              [取消]              [安装]               │
└──────────────────────────────────────────────────────┘
```

## 6.4 资源详情页

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回列表                                              │
│                                                          │
│  🧠 brainstorming [skill] v1.2.0                         │
│  ════════════════════════════════════════════════════     │
│                                                          │
│  描述: 在任何创造性工作之前进行需求分析和设计探索          │
│  来源: npm:superpowers-zh                                │
│  哈希: a1b2c3d4e5f6                                      │
│  大小: 4.0 KB                                            │
│  标签: design, planning                                  │
│  注册: 2026-07-05                                        │
│  安装状态: ✅ 已安装 → .claude/skills/brainstorming       │
│                                                          │
│  ── 依赖 ──                                              │
│  无依赖                                                  │
│                                                          │
│  ── 被依赖于 ──                                          │
│  · prd-impl (workflow)                                   │
│  · creative-flow (workflow)                              │
│                                                          │
│  ── 操作 ──                                              │
│  [卸载]  [更新]  [查看审计日志]                           │
│                                                          │
│  ── SKILL.md 预览 ──                                     │
│  ┌──────────────────────────────────────────────────┐    │
│  │ # Brainstorming                                   │    │
│  │                                                   │    │
│  │ 在任何创造性工作之前必须使用此技能...              │    │
│  │ ...                                               │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## 6.5 信任管理页

```
┌──────────────────────────────────────────────────────────┐
│  信任管理                                                │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ── 信任来源 ──                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ npm:superpowers-zh          信任于 2026-07-05     │  │
│  │ github:XzhiF/agents         信任于 2026-07-05     │  │
│  │ builtin:*                   始终信任              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ── 阻止来源 ──                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ npm:malicious-skill          阻止于 2026-07-05    │  │
│  │   原因: Reported by community                      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  [添加信任来源]  [添加阻止来源]                           │
└──────────────────────────────────────────────────────────┘
```

## 6.6 审计日志页

```
┌──────────────────────────────────────────────────────────┐
│  审计日志                                    [导出 JSON]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  过滤: [全部动作 ▾]  [全部资源 ▾]  最近 [20▾] 条         │
│                                                          │
│  时间                  动作              资源     调用者  │
│  ──────────────────   ────────────────  ──────── ────── │
│  07-05 10:30:15       resource.installed brainstorm human │
│  07-05 10:30:14       resource.installed tdd-wf    human │
│  07-05 10:30:10       lock.updated       -         human │
│  07-05 10:29:55       trust.added        npm:super human │
│  07-05 10:29:50       resource.registered brainstorm human│
│  07-05 10:25:00       cache.gc           -         human │
└──────────────────────────────────────────────────────────┘
```

## 6.7 组件设计

```
packages/web-app/components/resource/
├── ResourceTab.tsx              # Tab 容器
├── ResourceList.tsx             # 资源列表（卡片网格）
├── ResourceCard.tsx             # 单个资源卡片
├── ResourceDetail.tsx           # 资源详情页
├── ResourceSearch.tsx           # 搜索栏
├── InstallDialog.tsx            # 安装对话框
├── TrustManager.tsx             # 信任管理
├── AuditLog.tsx                 # 审计日志表格
├── DepsGraph.tsx                # 依赖图可视化
└── api.ts                       # API client 函数
```

### API Client

```typescript
// packages/web-app/lib/resource/api.ts

export async function listResources(opts?: { type?: string; tag?: string }): Promise<ListResponse>
export async function searchResources(query: string): Promise<SearchResponse>
export async function getResource(type: string, name: string): Promise<ResourceDetail>
export async function installResources(names: string[], workspace: string): Promise<InstallResponse>
export async function uninstallResource(name: string, workspace: string): Promise<void>
export async function registerResource(req: RegisterRequest): Promise<RegistryEntry>
export async function getAuditLog(opts?: { last?: number }): Promise<AuditEntry[]>
export async function getTrustStore(): Promise<TrustStoreData>
export async function addTrust(ref: SourceRef): Promise<void>
export async function blockSource(ref: SourceRef, reason: string): Promise<void>
```
