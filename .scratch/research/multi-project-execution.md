# 多项目工作流执行模式调研

> 调研日期: 2026-08-04
> 调研范围: Octopus WorkflowEngine 多项目执行能力、Clone Agent 机制、项目级配置传递

---

## 1. 当前多项目支持现状

### 1.1 工作空间拓扑结构

Octopus 通过 **workspace + git worktree** 管理多项目:

```
~/.octopus/orgs/{org}/workspaces/{ws-name}/
├── config.json              ← repos[] 注册表（group/name/worktree_path）
├── CLAUDE.md                ← workspace 级指令
├── projects/                ← 各项目 worktree
│   ├── {group}-{repo1}/     ← git worktree → 主仓库的分支
│   └── {group}-{repo2}/     ← git worktree
├── workflows/               ← YAML 工作流定义
├── state/                   ← 执行状态
└── .claude/skills/          ← workspace 级 skills
```

实现代码: `packages/core-pack/skills/octo-dev-copilot/scripts/workspace.ts`

### 1.2 Agent 节点 CWD 策略

**核心发现**: 当前所有节点共享**同一个 CWD** = workspace 根目录。

调用链:
```
ExecutionLifecycle.start()
  → EngineFactory.createEngine(execution, wf.parsed, callbacks, signal)
      → new WorkflowEngine(workflow, providers, workspacePath, workspacePath, ...)
                                            ↑ cwd = workspacePath
                                            ↑ orgDir = workspacePath
          → new ExecutorFactory({ cwd: this.cwd, ... })
              → new AgentNodeRunner(provider, this.ctx.cwd, ...)
                  → provider.sendQuery(prompt, this.cwd, ...)
```

关键代码位置:
- `packages/server/src/services/execution/EngineFactory.ts:91-92` — `new WorkflowEngine(workflow, providers, this.ctx.workspacePath, this.ctx.workspacePath, ...)`
- `packages/engine/src/executor-factory.ts:151` — `new AgentNodeRunner(provider, this.ctx.cwd, ...)`
- `packages/engine/src/executors/agent-runner.ts:14-15` — `constructor(provider, cwd, ...)`

**结论**: Agent 节点的 CWD 始终是 workspace 根目录，**不支持 per-node 的 CWD 覆盖**。

### 1.3 NodeDef Schema 无 cwd 字段

检查 `packages/shared/src/types/workflow.ts` 的 `NodeDef` 接口:

```typescript
export interface NodeDef {
  id: string
  type: "bash" | "python" | "agent" | "condition" | "approval" | "loop" | "swarm" | "interaction" | "sub_workflow" | "dynamic_sub_workflow"
  model?: string
  engine?: string
  // ... 无 cwd / working_dir / project 字段
}
```

**结论**: NodeDef 没有声明 `cwd`、`working_dir` 或 `project` 字段，无法在工作流 YAML 中指定某个节点在哪个项目目录下执行。

### 1.4 项目级 Knowledge 已有初步支持

`packages/server/src/services/knowledge/repo-resolver.ts` 中的 `resolveAllProjectNames(workspacePath)`:
- 扫描 `<workspace>/projects/` 子目录
- 从 git remote URL 提取 repo name
- 用于 Knowledge 服务的 scope 过滤

`ExecutionLifecycle.start()` 中的调用:
```typescript
const repoNames = resolveAllProjectNames(this.workspacePath)
this.knowledgeService?.setExecutionContext(repoNames, wf.parsed.name)
```

**结论**: Knowledge 系统已有多项目意识（能识别 workspace 下的多个 repo），但 Agent 执行层没有。

### 1.5 Claude Provider 的 .claude 配置发现

`packages/providers/src/claude/provider.ts:220-226`:
```typescript
const sdkOptions: Options = {
  cwd,                                    // ← 决定 .claude/ 发现路径
  settingSources: ['project', 'user'],    // ← 同时读取 project 和 user 级配置
  ...
}
```

Claude Agent SDK 根据 `cwd` 参数自动发现:
- `{cwd}/.claude/settings.json` — project 级设置
- `{cwd}/.claude/rules/*.md` — project 级规则
- `{cwd}/CLAUDE.md` — project 级指令

**当前问题**: 因为 cwd 始终是 workspace 根，所以 Claude SDK 只能发现 workspace 级的 `.claude/` 配置，**无法发现各项目 worktree 内的项目级配置**。

---

## 2. 多 Agent 框架 vs Clone Agent 节点对比

### 2.1 方案 A: 多 Agent 框架（LangGraph/CrewAI/AutoGen 模式）

| 维度 | 评估 |
|------|------|
| 核心模型 | 独立 agent 进程，各有自己的 context/tools/memory，通过 message bus 通信 |
| Octopus 适配 | 需要构建 agent-to-agent 通信层、任务调度器、共享状态管理 |
| 与现有架构的冲突 | 当前 engine 是**单进程顺序/DAG 执行**模型，多 agent 框架需要根本性的架构改造 |
| 优势 | 真正的并行执行、独立的上下文窗口、灵活的消息传递模式 |
| 劣势 | 复杂度高、与当前 engine 不兼容、调试困难、成本高（多个并行 Claude session） |

**关键冲突**: Octopus 的 WorkflowEngine 是**节点顺序执行**模型（DAG/chain/loop/swarm），每个节点是一个同步的 `execute() → result` 调用。引入多 agent 框架意味着:
1. 需要异步消息传递基础设施
2. 需要 agent 注册/发现/生命周期管理
3. 需要解决 Claude SDK session 的并发和状态共享问题

### 2.2 方案 B: Clone Agent 节点（Octopus 原生方案）

| 维度 | 评估 |
|------|------|
| 核心模型 | 在 workflow YAML 中定义 clone agent 节点，每个 clone 有 persona/skills/memory |
| 现有实现 | `builtin-clones.ts` 定义了 4 个内置 clone（workspace/scheduler/archive/resource） |
| Clone Runtime | `clone-runtime.ts` 实现了 context assembly（persona + skills + memory → system prompt） |
| 与现有架构的兼容性 | **高度兼容** — clone 通过 `CloneRuntime.chat()` 调用同一个 Claude Provider |
| 优势 | 复用现有基础设施、clone 已有独立的 memory/skills 管理、增量改进即可 |
| 劣势 | clone 目前只用于 chat session，尚未集成到 workflow engine 节点 |

**CloneRuntime 已有的能力**:

1. **Context Assembly** (`assembleContext()`):
   - Persona (clone 身份)
   - Shared memory (全局长期 + daily，只读)
   - Own memory (clone 私有长期 + daily)
   - Memory guidance (告诉 clone 如何管理记忆)

2. **Plugin Discovery** (`getPlugins()`):
   - Tier 1: `~/.octopus/agent/skills/` — 全局 skills
   - Tier 2: `built-in/{name}/skills/` 或 `clones/{name}/skills/` — clone 专属 skills

3. **CWD Strategy** (`getDefaultCwd()`):
   - built-in clone → `~/.octopus/agent/built-in/{name}/`
   - user clone → `~/.octopus/agent/clones/{name}/`
   - 调用者可覆盖

4. **Provider Call** (`sendWithProvider()`):
   - 使用 Claude SDK 的 `systemPrompt: { type: 'preset', preset: 'claude_code', append: cloneSystemPrompt }`
   - 支持 session resume
   - 支持 abort

### 2.3 对比总结

| 对比维度 | 方案 A: 多 Agent 框架 | 方案 B: Clone Agent 节点 |
|----------|----------------------|-------------------------|
| 实现复杂度 | 🔴 高（全新基础设施） | 🟢 低（增量改进） |
| 与现有架构兼容性 | 🔴 不兼容 | 🟢 高度兼容 |
| 多项目 CWD 支持 | 🟡 需要额外设计 | 🟢 可通过 node 级 cwd 实现 |
| 独立上下文 | 🟢 天然支持 | 🟢 clone 已有独立 memory |
| 并行执行 | 🟢 天然支持 | 🟡 需要 workflow 层并行编排 |
| 调试可观测性 | 🔴 分布式调试困难 | 🟢 复用现有 JSONL/SSE |
| 成本效率 | 🔴 多个并行 session | 🟢 单 session + 按需 resume |
| 项目级配置 | 🟡 需要新机制 | 🟢 可通过 cwd 切换自动发现 |

**建议**: 采用 **方案 B（Clone Agent 节点）** 作为主路径。它复用 Octopus 已有的 CloneRuntime 基础设施，增量成本低，且能天然解决多项目 CWD 问题。

---

## 3. 项目级配置传递方案

### 3.1 核心问题

Claude Agent SDK 根据 `cwd` 参数自动发现项目级配置:
- `{cwd}/CLAUDE.md`
- `{cwd}/.claude/settings.json`
- `{cwd}/.claude/rules/*.md`

当前 cwd 固定为 workspace 根，无法发现 `projects/{group}-{repo}/.claude/` 下的配置。

### 3.2 方案: Per-Node CWD + 配置层级

#### Step 1: NodeDef 增加 cwd 字段

在 `packages/shared/src/types/workflow.ts` 中扩展:

```typescript
export interface NodeDef {
  // ... 现有字段
  cwd?: string  // 可选：节点级工作目录覆盖
  project?: string  // 可选：项目名引用（解析为 projects/{project}/ 路径）
}
```

#### Step 2: ExecutorFactory 解析 per-node CWD

在 `packages/engine/src/executor-factory.ts` 中:

```typescript
case "agent": {
  // 解析节点级 CWD
  const nodeCwd = node.cwd
    ? path.resolve(this.ctx.cwd, node.cwd)
    : node.project
      ? path.resolve(this.ctx.cwd, 'projects', node.project)
      : this.ctx.cwd

  const runner = new AgentNodeRunner(provider, nodeCwd, ...)
}
```

#### Step 3: 配置层级合并

Claude SDK 的 `settingSources: ['project', 'user']` 已经支持:
- **Project level**: `{cwd}/.claude/settings.json` — 项目级
- **User level**: `~/.claude/settings.json` — 用户级

只需正确设置 cwd，SDK 会自动发现并合并配置。

### 3.3 配置传递的具体路径

```
workspace/
├── .claude/                    ← workspace 级配置（当前 cwd 指向这里）
│   ├── settings.json           ← workspace + user 合并
│   └── skills/
├── projects/
│   ├── group-repo-a/           ← 项目 A worktree
│   │   ├── .claude/
│   │   │   ├── settings.json   ← 项目 A 级配置
│   │   │   └── rules/*.md      ← 项目 A 级规则
│   │   └── CLAUDE.md           ← 项目 A 指令
│   └── group-repo-b/           ← 项目 B worktree
│       ├── .claude/
│       │   └── rules/*.md
│       └── CLAUDE.md
```

**工作流 YAML 示例**:

```yaml
nodes:
  - id: fix-frontend
    type: agent
    project: webapp-repo         # 解析为 projects/webapp-repo/
    prompt: "修复 $vars.bug_description"
    skills: [octo-workflow-dev]

  - id: fix-backend
    type: agent
    project: api-server          # 解析为 projects/api-server/
    prompt: "修复 $vars.bug_description"

  - id: integration-test
    type: bash
    cwd: projects/api-server     # 直接指定相对路径
    bash: "pnpm test:integration"
```

### 3.4 Knowledge 注入与 .claude 配置的互补

当前已有的 `KnowledgeInjector` 通过 VarPool 注入 knowledge rules，与 `.claude/rules/` 的自动发现是**互补关系**:

| 层级 | 机制 | 来源 |
|------|------|------|
| Workspace 级 | `.claude/rules/` 自动发现 | workspace 根目录 |
| Project 级 | `.claude/rules/` 自动发现 | per-node cwd 指向项目目录 |
| Org 级 | `KnowledgeInjector` + VarPool | `~/.octopus/{org}/knowledge/` |
| 执行历史 | `KnowledgeInjector` + VarPool | DB 中的 effectiveness tracking |

---

## 4. 建议的实施路径

### Phase 1: Per-Node CWD 支持（最小可行）

**目标**: 让 agent/bash 节点可以指定项目级 cwd

1. **shared**: `NodeDef` 增加 `cwd?: string` 和 `project?: string` 字段
2. **shared**: `NodeSchema` 增加对应 Zod 验证
3. **engine**: `ExecutorFactory.createExecutor()` 解析 per-node cwd
4. **engine**: 对 `bash` / `agent` / `python` 三种 executor 传递解析后的 cwd
5. **测试**: 验证 cwd 切换后 Claude SDK 能正确发现项目级 `.claude/` 配置

**工作量**: ~2-3 天
**风险**: 低（仅添加字段，不影响现有逻辑）

### Phase 2: Clone Agent 节点类型（核心能力）

**目标**: 在 workflow YAML 中定义 clone agent 节点

1. **shared**: `NodeDef.type` 增加 `"clone_agent"` 类型
2. **shared**: 定义 `CloneAgentDef` schema（name, persona, skills, memoryScope, project/cwd）
3. **engine**: `CloneAgentExecutor` — 内部使用 `CloneRuntime` 组装 context，然后调用 `AgentNodeRunner`
4. **server**: `EngineFactory` 注册 `CloneAgentExecutor`
5. **YAML 示例**:
   ```yaml
   nodes:
     - id: frontend-dev
       type: clone_agent
       clone: frontend-specialist
       project: webapp-repo
       prompt: "实现 $vars.feature_description"
   ```

**工作量**: ~3-5 天
**风险**: 中（需要 CloneRuntime 适配 workflow engine 的接口）

### Phase 3: 多项目编排模式（高级）

**目标**: 支持 DAG 模式下的多项目并行编排

1. **engine**: DAG 调度器感知 per-node cwd，支持跨项目的依赖关系
2. **engine**: 支持 `$project.node-id.output.xxx` 跨项目变量引用
3. **server**: 多项目 git 操作（各项目独立 commit/branch）
4. **web-app**: 执行可视化显示各项目节点的进度

**工作量**: ~5-7 天
**风险**: 中-高（涉及 DAG 并行调度的并发安全）

### Phase 4: 跨项目知识共享（增强）

**目标**: 项目间的知识规则自动传播

1. **knowledge**: 支持 `knowledge_scope.projects` 过滤的跨项目规则
2. **knowledge**: 项目 A 的经验规则可注入到项目 B 的 agent 上下文
3. **knowledge**: 工作流级 knowledge 聚合（跨所有项目）

**工作量**: ~2-3 天
**风险**: 低（在现有 KnowledgeInjector 上扩展）

---

## 5. 关键代码位置索引

| 功能 | 文件路径 | 关键行 |
|------|----------|--------|
| Agent CWD 传递 | `packages/engine/src/executor-factory.ts` | L151 |
| AgentNodeRunner | `packages/engine/src/executors/agent-runner.ts` | L14-15 |
| WorkflowEngine 构造 | `packages/engine/src/engine.ts` | L126-129 |
| Engine 创建 | `packages/server/src/services/execution/EngineFactory.ts` | L91 |
| NodeDef Schema | `packages/shared/src/types/workflow.ts` | L160-257 |
| Claude SDK cwd | `packages/providers/src/claude/provider.ts` | L220-221 |
| Clone Runtime | `packages/server/src/services/agent/clone-runtime.ts` | L52-595 |
| Built-in Clones | `packages/server/src/services/agent/builtin-clones.ts` | L79-116 |
| Repo Resolver | `packages/server/src/services/knowledge/repo-resolver.ts` | L65-101 |
| Workspace 管理 | `packages/core-pack/skills/octo-dev-copilot/scripts/workspace.ts` | L640-758 |
| Knowledge 注入 | `packages/engine/src/knowledge-injector.ts` | (整个文件) |

---

## 6. 决策建议

**推荐路径**: **方案 B（Clone Agent 节点）+ Per-Node CWD**

理由:
1. **最小改动**: 不需要改造 WorkflowEngine 的执行模型，只需在 NodeDef 上添加字段
2. **复用已有**: CloneRuntime 已经实现了 persona/skills/memory 的完整管理
3. **渐进式**: Phase 1（per-node cwd）可以独立交付价值，Phase 2（clone agent）在此基础上叠加
4. **配置自动发现**: 通过 cwd 切换，Claude SDK 自动发现项目级 `.claude/` 配置，无需自建配置合并逻辑
5. **成本可控**: 每个 clone agent 节点仍是一个 Claude session，不会引入额外的并行 session 开销
