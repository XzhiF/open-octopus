# 架构研究：WorkflowEngine AgentExecutor 改造为 Built-in Clone Agent

> 研究日期: 2026-08-04
> 研究者: Architecture Research Agent
> 状态: 完成

## 1. 执行摘要

本报告深入研究了将 WorkflowEngine 的 AgentExecutor 改造为 System Built-in Clone Agent 的可行性。核心发现：

- **两个系统目前完全独立**：WorkflowEngine AgentExecutor 是临时任务执行器，无状态；Clone Agent 是交互式会话系统，有完整的 memory/skills/MCP 生态
- **技术可行但需要权衡**：合并可以让工作流节点获得持久记忆和技能学习能力，但会增加复杂度和 token 成本
- **推荐渐进式方案**：不立即合并，而是让 AgentExecutor 可选注入 CloneRuntime 的能力（memory context、skills discovery），保持核心执行逻辑独立

## 2. 当前架构对比

### 2.1 WorkflowEngine AgentExecutor

**位置**: `packages/engine/src/executors/agent.ts`

**核心职责**: 执行工作流 YAML 中 `type: agent` 的节点，将 prompt 发送到 Claude API 并收集结果

**架构层次**:
```
WorkflowEngine (engine.ts)
  └─> AgentExecutor (agent.ts)
       └─> AgentNodeRunner (agent-runner.ts)
            └─> IAgentProvider.sendQuery() (providers/types.ts)
                 └─> ClaudeSDKProvider (providers/claude-sdk.ts)
```

**关键特性**:
- **无状态执行**: 每次执行独立，无持久记忆（除非通过 VarPool 传递 `$vars.xxx`）
- **Prompt 构建**: `buildPrompt()` 方法组合以下来源：
  - 节点 `prompt` 或 `goal` 字段
  - 变量替换: `$vars.xxx`, `$node-id.output.xxx`, `$last_output`
  - PromptInjector: 全局/工作流级别的 prompt 注入
  - KnowledgeInjector: 知识库规则注入（用户偏好、项目规则）
  - Auto-answers: 预设问答对
  - Agent role: `你作为 {agent} 角色执行此任务`
- **工具调用**: 通过 Claude Agent SDK 原生工具（Read, Write, Bash 等）
- **Session resume**: 支持 `previousSessionId` 继续上次会话（用于中断恢复）
- **超时控制**: 活动超时 + 心跳监控 + 空闲超时（20分钟）

**配置接口** (`executor-config.ts`):
```typescript
interface AgentConfig {
  runner: AgentNodeRunner              // 必需：Claude API 包装器
  engineContext?: EngineContext        // 前序节点结果
  loopContext?: Record<string, any>    // 循环上下文
  previousSessionId?: string           // 会话续接
  signal?: AbortSignal                 // 取消信号
  globalAutoAnswers?: AutoAnswer[]     // 预设问答
  promptInjector?: PromptInjector      // prompt 注入器
  knowledgeInjector?: KnowledgeInjector // 知识注入器
  workflowName?: string                // 工作流名称
  crossExecResolver?: CrossExecResolver // 跨执行变量解析
  executionId?: string                 // 执行 ID
  resolvedModel?: string               // 模型名称
  modelAliasConfig?: ModelAliasConfig  // 模型别名配置
}
```

**使用场景**:
1. 工作流 YAML 中的 `type: agent` 节点
2. Hook 执行器中的 agent hook（`HookExecutor.ts`）
3. Recovery 流程中的 pending hook 恢复（`RecoveryManager.ts`）

### 2.2 Clone Agent System

**位置**: `packages/server/src/services/agent/`

**核心职责**: 提供交互式 AI 助手，具有持久记忆、技能学习、人格定制能力

**架构层次**:
```
Main Agent Route (routes/agent/main-agent-route.ts)
  └─> CloneRuntime (clone-runtime.ts)
       ├─> Context Assembly (assembleContext)
       │    ├─> Persona (persona.md)
       │    ├─> Shared Memory (long-term.md + daily/)
       │    ├─> Own Memory (clone-specific)
       │    └─> Memory Guidance (record_daily 工具)
       ├─> Plugin Discovery (getPlugins)
       │    ├─> ~/.octopus/agent/skills/ (Tier 1: 共享)
       │    └─> built-in/{name}/skills/ (Tier 2: 专属)
       └─> Provider Call (sendWithProvider)
            └─> IAgentProvider.sendQuery() with plugins
```

**Built-in Clones** (`builtin-clones.ts`):
```typescript
const BUILTIN_CLONES: CloneDef[] = [
  { name: 'workspace', displayName: '全栈开发助手', memoryScope: 'shared' },
  { name: 'scheduler', displayName: '定时任务管理', memoryScope: 'isolated', skills: ['octo-scheduler'] },
  { name: 'archive', displayName: '工程分析师', memoryScope: 'shared', skills: ['octo-archive-analyst'] },
  { name: 'resource', displayName: '资源操作专家', memoryScope: 'isolated', skills: ['octo-resource-manager'] },
]
```

**关键特性**:
- **持久记忆**: 三层记忆系统
  - Long-term memory: `~/.octopus/{org}/agent/memory/long-term.md`
  - Daily memory: `~/.octopus/{org}/agent/memory/daily/YYYY-MM-DD.md`
  - Clone-specific memory: `~/.octopus/agent/built-in/{name}/memory/`
- **技能系统**: Claude Agent SDK plugins 机制（ADR-006）
  - Tier 1 (shared): `~/.octopus/{org}/agent/skills/`
  - Tier 2 (clone): `built-in/{name}/skills/` 或 `clones/{name}/skills/`
  - 同名优先级: clone > shared
  - 白名单过滤: `cloneDef.skills []` = 全部；非空 = 仅白名单
- **人格定制**: `persona.md` 文件定义身份、原则、能力
- **进化系统**: `mark_insight`, `evolve_skill`, `create_experience`, `merge_skills`
- **SystemPromptAssembler**: 7 段式 prompt 构建 + 预算截断（8000 tokens）
  - Priority: core (0) > persona (1) > memory (3) > daily (3) > skills (2) > context (4) > clone (5)
- **Delegation**: 工具调用转发到其他 clone（`delegate_to_workspace`, `delegate_to_scheduler` 等）

**使用场景**:
1. Web UI 交互式会话（`/api/agent/chat`）
2. 定时任务的 agent 类型执行（`scheduler/executors/agent-executor.ts`）
3. 通过 `@@mention` 或工具调用进行任务委托

### 2.3 关键差异总结

| 维度 | WorkflowEngine AgentExecutor | Clone Agent |
|------|------------------------------|-------------|
| **执行模式** | 临时任务，一次性执行 | 交互式会话，多轮对话 |
| **状态管理** | 无状态（VarPool 临时传递） | 有状态（持久化 memory） |
| **Prompt 构建** | 节点 prompt + 变量替换 + 注入器 | SystemPromptAssembler (7段 + 预算) |
| **技能系统** | 无（依赖 Claude 原生工具） | Claude SDK plugins + 技能进化 |
| **记忆系统** | 无（仅 `$vars.xxx` 临时变量） | 三层记忆（long-term + daily + session） |
| **MCP 能力** | 无（仅 Claude 原生工具） | 可通过 plugins 访问 MCP 服务 |
| **人格/角色** | 简单角色声明 (`你作为 {agent}`) | 完整 persona.md + 身份定制 |
| **调用路径** | `AgentNodeRunner.run()` | `CloneRuntime.chat()` |
| **Session 管理** | `previousSessionId` (续接) | 完整 session DAO + provider_session_id |
| **文件位置** | `packages/engine/` | `packages/server/src/services/agent/` |

## 3. 合并方案分析

### 3.1 方案 A：完全合并（AgentExecutor 成为 Clone）

**思路**: 将 AgentExecutor 改造为第 5 个 built-in clone（如 `workflow-executor`），拥有独立的 persona、memory、skills

**实现路径**:
```typescript
// builtin-clones.ts 新增
{
  name: 'workflow-executor',
  displayName: '工作流执行专家',
  type: 'built-in',
  persona: WORKFLOW_EXECUTOR_PERSONA,
  skills: ['octo-workflow-dev', 'octo-engine-debug'],
  memoryScope: 'shared',  // 或 isolated
  config: {},
}
```

**改造点**:
1. **AgentExecutor 注入 CloneRuntime**:
   ```typescript
   interface AgentConfig {
     runner: AgentNodeRunner
     cloneRuntime?: CloneRuntime  // 新增
     // ...
   }
   ```

2. **Prompt 构建整合**:
   ```typescript
   private buildPrompt(): string {
     // 1. Clone context (persona + memory + skills)
     const cloneContext = this.cloneRuntime?.assembleContext() ?? ''

     // 2. Workflow-specific prompt
     const workflowPrompt = this.buildWorkflowPrompt()

     // 3. Combine
     return `${cloneContext}\n\n---\n\n${workflowPrompt}`
   }
   ```

3. **Runner 使用 plugins**:
   ```typescript
   const stream = this.provider.sendQuery(prompt, cwd, sessionId, {
     systemPrompt: { type: 'preset', preset: 'claude_code', append: cloneContext },
     plugins: this.cloneRuntime?.getPlugins() ?? [],
   })
   ```

**优势**:
- ✅ 工作流节点获得持久记忆（可学习历史执行模式）
- ✅ 技能系统可复用（octo-workflow-dev, octo-engine-debug）
- ✅ 统一的 Agent 能力模型（所有 AI 执行都通过 Clone 抽象）
- ✅ 进化系统可应用于工作流执行（自动优化 prompt、技能）

**风险**:
- ❌ **复杂度爆炸**: AgentExecutor 从 160 行膨胀到 300+ 行
- ❌ **Token 成本增加**: 每次执行注入 persona + memory + skills（~2000-4000 tokens）
- ❌ **耦合风险**: Engine 包依赖 Server 包（破坏 `engine ← shared+providers` 依赖链）
- ❌ **性能影响**: 每次执行读取文件系统（memory、skills、persona）
- ❌ **概念混乱**: 临时任务 vs 持久身份的边界模糊

**评估**: **不推荐**。过度设计，破坏架构分层，收益不明显。

---

### 3.2 方案 B：能力注入（AgentExecutor 可选使用 Clone 能力）

**思路**: 保持 AgentExecutor 独立，但允许通过配置注入 memory context 和 skills discovery

**实现路径**:
```typescript
interface AgentConfig {
  runner: AgentNodeRunner
  // 新增：可选能力注入
  memoryContext?: {
    longTerm?: string      // 长期记忆摘要
    daily?: string         // 今日工作记忆
    cloneName?: string     // 来源 clone 名称
  }
  skillsDiscovery?: {
    pluginPaths: string[]  // Claude SDK plugin paths
    skillFilter?: string[] // 技能白名单
  }
  personaOverride?: string // 人格覆盖（替代 node.agent）
}
```

**改造点**:
1. **Prompt 构建增强**:
   ```typescript
   private buildPrompt(): string {
     let prompt = this.node.prompt ?? ''

     // 1. Memory context injection
     if (this.config.memoryContext) {
       const memParts: string[] = []
       if (this.config.memoryContext.longTerm) {
         memParts.push(`# 长期记忆\n\n${this.config.memoryContext.longTerm}`)
       }
       if (this.config.memoryContext.daily) {
         memParts.push(`# 工作记忆\n\n${this.config.memoryContext.daily}`)
       }
       if (memParts.length > 0) {
         prompt = memParts.join('\n\n') + '\n\n---\n\n' + prompt
       }
     }

     // 2. Persona override
     if (this.config.personaOverride) {
       prompt = `# 角色\n\n${this.config.personaOverride}\n\n---\n\n${prompt}`
     }

     // 3. Existing variable substitution + injectors
     prompt = substituteVarsFull(prompt, ...)
     // ... PromptInjector, KnowledgeInjector, etc.
   }
   ```

2. **Runner 传递 plugins**:
   ```typescript
   const result = await this.runner.run({
     prompt,
     plugins: this.config.skillsDiscovery?.pluginPaths,
     // ...
   })
   ```

3. **Server 层组装能力**:
   ```typescript
   // EngineFactory.ts
   const memoryContext = this.buildMemoryContextForWorkflow(workflowName)
   const skillsDiscovery = this.buildSkillsDiscovery(workflowName)

   const engine = new WorkflowEngine(workflow, providers, cwd, {
     memoryContext,
     skillsDiscovery,
     // ...
   })
   ```

**优势**:
- ✅ **渐进式**: 不破坏现有架构，可选启用
- ✅ **低耦合**: Engine 包不依赖 Server 包（仅传递配置）
- ✅ **灵活性**: 工作流可选择注入哪些能力
- ✅ **性能可控**: 仅在需要时读取 memory/skills
- ✅ **概念清晰**: 临时任务 + 可选持久能力

**风险**:
- ⚠️ 需要设计 YAML 配置语法（如何声明使用 memory/skills）
- ⚠️ Memory context 截断策略（避免 token 爆炸）
- ⚠️ 技能过滤逻辑（哪些技能适合工作流节点）

**评估**: **推荐**。平衡了能力增强和架构稳定性。

---

### 3.3 方案 C：共享基础设施（独立但复用组件）

**思路**: 保持两个系统独立，但抽取共享组件（Memory Reader、Skill Discovery）

**实现路径**:
```typescript
// packages/shared/src/agent-capabilities/
├── memory-reader.ts       // 读取 memory 文件
├── skill-discovery.ts     // Claude SDK plugins 构建
└── prompt-assembler.ts    // 通用 prompt 组装（简化版 SystemPromptAssembler）
```

**改造点**:
1. **抽取共享组件**:
   ```typescript
   // shared/src/agent-capabilities/memory-reader.ts
   export class MemoryReader {
     static readLongTerm(org: string): string { ... }
     static readDaily(org: string, days: number): string { ... }
     static readCloneMemory(cloneName: string): string { ... }
   }
   ```

2. **AgentExecutor 使用共享组件**:
   ```typescript
   import { MemoryReader, SkillDiscovery } from '@octopus/shared'

   private buildPrompt(): string {
     const memory = MemoryReader.readDaily(this.org, 1)
     const plugins = SkillDiscovery.buildPlugins(this.org)
     // ...
   }
   ```

**优势**:
- ✅ **零耦合**: 两个系统完全独立
- ✅ **复用**: 共享组件避免重复实现
- ✅ **演进**: 各自独立演进，不影响对方

**风险**:
- ⚠️ 组件抽象可能过度设计（当前仅两个消费者）
- ⚠️ 共享组件的 API 设计需要谨慎（避免泄漏实现细节）

**评估**: **保守方案**。适合当前阶段，但长期可能需要更紧密的整合。

---

## 4. 风险评估

### 4.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **Token 成本爆炸** | 高 | 高 | Memory context 截断（~1000 tokens），技能白名单过滤 |
| **架构分层破坏** | 高 | 中 | 方案 B（能力注入）保持 Engine 包独立 |
| **性能退化** | 中 | 中 | 缓存 memory 读取，延迟加载 skills |
| **概念混乱** | 中 | 低 | 清晰文档：临时任务 vs 持久能力 |
| **兼容性破坏** | 低 | 低 | 所有能力可选，默认关闭 |

### 4.2 架构风险

**依赖链破坏**:
```
当前: engine ← shared + providers
合并后: engine ← shared + providers + server (❌ 循环依赖)
```

**缓解**: 方案 B 通过配置传递能力，不引入包依赖

**抽象泄漏**:
```
AgentExecutor 需要知道：
- memory 文件格式？
- skills 目录结构？
- persona.md 解析逻辑？
```

**缓解**: 共享组件封装细节，AgentExecutor 仅接收字符串/路径

### 4.3 运维风险

**调试复杂度**: 工作流执行失败时，需要排查 memory/skills/persona 注入问题

**缓解**: JSONL 日志记录注入的 context（已存在 `__injected_rule_ids` 模式）

**配置管理**: YAML 需要声明使用哪些能力，增加配置复杂度

**缓解**: 提供默认配置，仅在需要时覆盖

---

## 5. 建议

### 5.1 推荐方案：方案 B（能力注入）

**理由**:
1. **渐进式**: 不破坏现有架构，可选启用
2. **低耦合**: Engine 包不依赖 Server 包
3. **灵活性**: 工作流可选择注入哪些能力
4. **性能可控**: 仅在需要时读取 memory/skills

### 5.2 实施路径

**Phase 1: Memory Context Injection (1-2 周)**
```yaml
# workflow.yaml
nodes:
  - id: analyze-code
    type: agent
    prompt: "分析代码质量..."
    memory:
      enabled: true
      scope: daily  # daily | long-term | both
      clone: workspace  # 可选：从特定 clone 读取
```

**Phase 2: Skills Discovery (1-2 周)**
```yaml
nodes:
  - id: fix-bugs
    type: agent
    prompt: "修复 bug..."
    skills:
      enabled: true
      filter:
        - octo-engine-debug
        - octo-workflow-dev
```

**Phase 3: Persona Override (可选)**
```yaml
nodes:
  - id: review-pr
    type: agent
    persona: |
      你是代码审查专家，关注安全性和性能...
    prompt: "审查此 PR..."
```

### 5.3 关键设计决策

**Memory Context 截断策略**:
- Daily memory: 最近 1 天，~500 tokens
- Long-term memory: 提取 "经验教训" + "偏好" 章节，~1000 tokens
- 总预算: ~1500 tokens（与 SystemPromptAssembler 一致）

**Skills 过滤策略**:
- 默认: 仅 `octo-workflow-dev`, `octo-engine-debug`
- 白名单: YAML `skills.filter` 字段
- 黑名单: 排除 `octo-agent-*` 系列（交互式技能）

**配置语法**:
- 节点级别: `memory.enabled`, `skills.enabled`
- 工作流级别: `workflow.memory`, `workflow.skills`（全局默认）
- 优先级: 节点 > 工作流 > 系统默认

### 5.4 不推荐的做法

- ❌ 将 AgentExecutor 改造为 Clone（过度设计）
- ❌ 让工作流节点访问完整 memory（token 成本过高）
- ❌ 让工作流节点使用进化系统（临时任务不适合学习）
- ❌ 让工作流节点有人格（概念混乱）

---

## 6. Harness 初步思考

### 6.1 当前问题

**问题描述**: E2E 测试中，agent 节点可能执行 `kill` 命令杀掉自己的进程，导致测试失败

**根因分析**:
1. Agent 节点通过 Claude SDK 获得 Bash 工具
2. Claude 模型可能生成 `kill -9 $$` 或 `pkill -f node` 等命令
3. 这些命令杀掉执行 agent 的进程，导致测试中断

**代码路径**:
```
AgentExecutor.execute()
  └─> AgentNodeRunner.run()
       └─> IAgentProvider.sendQuery()
            └─> Claude SDK subprocess
                 └─> Bash tool execution
                      └─> kill command (❌ 杀掉自己)
```

### 6.2 Harness 模式概述

**Harness 模式定义**: 测试框架包裹被测系统，拦截危险操作，提供 mock/stub

**其他项目的实现**:
- **Claude Code**: `canUseTool` 回调拦截 `AskUserQuestion` 工具
- **Kubernetes**: Pod Security Policy 限制容器权限
- **Docker**: `--security-opt` 限制容器能力

### 6.3 Octopus 的 Harness 方案

**方案 A: Tool 拦截器**
```typescript
// providers/claude-sdk.ts
const stream = this.sdk.sendQuery(prompt, {
  canUseTool: (toolName, input) => {
    if (toolName === 'Bash' && isDangerousCommand(input.command)) {
      return { allowed: false, reason: 'Test harness blocked dangerous command' }
    }
    return { allowed: true }
  },
})
```

**方案 B: 沙箱执行**
```typescript
// engine/executors/agent.ts
const runner = new AgentNodeRunner(provider, cwd, {
  sandbox: true,  // 启用沙箱
  allowedCommands: ['ls', 'cat', 'grep'],  // 白名单
})
```

**方案 C: E2E 测试专用配置**
```yaml
# e2e-harness.config.yaml
workflow:
  overrides:
    agent_nodes:
      disallowed_tools:
        - Bash  # 完全禁用 Bash 工具
      # 或
      bash_restrictions:
        deny_patterns:
          - 'kill*'
          - 'pkill*'
          - 'rm -rf*'
```

**推荐**: 方案 A（Tool 拦截器）+ 方案 C（测试专用配置）

**实现优先级**:
1. P0: 在 E2E 测试中拦截 `kill` 命令
2. P1: 通用危险命令拦截（`rm -rf`, `force push` 等）
3. P2: 可配置的 tool 白名单/黑名单
4. P3: 完整沙箱模式（Docker/gVisor）

---

## 7. 引用来源

### 7.1 WorkflowEngine AgentExecutor

| 文件 | 路径 | 职责 |
|------|------|------|
| AgentExecutor | `packages/engine/src/executors/agent.ts` | 核心执行器，prompt 构建 + 结果处理 |
| AgentNodeRunner | `packages/engine/src/executors/agent-runner.ts` | Claude API 包装器，stream 处理 |
| AgentTypes | `packages/engine/src/executors/agent-types.ts` | 事件类型定义 |
| AgentConfig | `packages/engine/src/executors/executor-config.ts` | 配置接口定义 |
| PromptInjector | `packages/engine/src/prompt-injector.ts` | 全局/工作流 prompt 注入 |
| KnowledgeInjector | `packages/engine/src/knowledge-injector.ts` | 知识库规则注入 |

### 7.2 Clone Agent System

| 文件 | 路径 | 职责 |
|------|------|------|
| BuiltinClones | `packages/server/src/services/agent/builtin-clones.ts` | 4 个内置 clone 定义 |
| CloneRuntime | `packages/server/src/services/agent/clone-runtime.ts` | Context assembly + provider call |
| CloneResolver | `packages/server/src/services/agent/clone-resolver.ts` | 文件系统 clone 解析 |
| CloneInitService | `packages/server/src/services/agent/clone-init-service.ts` | 启动时初始化 built-in clones |
| SystemPromptAssembler | `packages/server/src/services/agent/system-prompt-assembler.ts` | 7 段式 prompt 构建 + 预算截断 |
| MainAgentRoute | `packages/server/src/routes/agent/main-agent-route.ts` | Web UI 交互 + delegation |
| AgentService | `packages/server/src/services/agent/agent-service.ts` | Session/memory/clone/skill 管理 |

### 7.3 共享组件

| 文件 | 路径 | 职责 |
|------|------|------|
| IAgentProvider | `packages/providers/src/types.ts` | Provider 接口定义 |
| CloneDef | `packages/shared/src/types/agent.ts` | Clone 定义类型 |
| SubsystemAdapter | `packages/server/src/services/agent/subsystem-adapter.ts` | Skill search + MCP registry |

### 7.4 调用路径

| 场景 | 路径 |
|------|------|
| 工作流执行 | `ExecutionService.start()` → `ExecutionLifecycle.start()` → `EngineFactory.createEngine()` → `WorkflowEngine.run()` → `AgentExecutor.execute()` |
| Hook 执行 | `HookExecutor.executeAgentHook()` → `new AgentNodeRunner()` → `AgentExecutor.execute()` |
| Clone 会话 | `MainAgentRoute.post('/chat')` → `CloneRuntime.chat()` → `IAgentProvider.sendQuery()` |
| Delegation | `MainAgentRoute` → `executeDelegation()` → `CloneRuntime.chat()` |

---

## 8. 附录：关键代码片段

### 8.1 AgentExecutor Prompt 构建（当前）

```typescript
// packages/engine/src/executors/agent.ts:311-350
private buildPrompt(): string {
  if (this.node.goal) {
    return this.buildGoalPrompt()
  }

  let prompt = this.node.prompt ?? ""
  prompt = substituteVarsFull(prompt, this.pool, ...)

  // Inject pipeline-level prompts (global + targeted)
  if (this.promptInjector && this.workflowName) {
    const injectedPrompts = this.promptInjector.getInjectedPrompts(this.workflowName, this.node.id)
    if (injectedPrompts.length > 0) {
      prompt = injectedPrompts.join("\n\n---\n\n") + "\n\n---\n\n" + prompt
    }
  }

  // Inject knowledge prompts
  if (this.knowledgeInjector && this.workflowName) {
    const knowledgePrompts = this.knowledgeInjector.getInjectedPrompts(this.workflowName, this.node.id)
    if (knowledgePrompts.length > 0) {
      prompt = knowledgePrompts.join("\n\n---\n\n") + "\n\n---\n\n" + prompt
    }
  }

  const compiled = compileAutoAnswers(this.globalAutoAnswers ?? [], nodeAnswers)
  if (compiled) {
    prompt += "\n\n" + compiled
  }

  if (this.node.agent) {
    prompt += `\n\n你作为 ${this.node.agent} 角色执行此任务。`
  }

  return prompt
}
```

### 8.2 CloneRuntime Context Assembly（当前）

```typescript
// packages/server/src/services/agent/clone-runtime.ts:91-123
assembleContext(): string {
  const segments: string[] = []

  // 1. Persona (replaces main agent persona)
  const persona = this.loadPersona()
  if (persona) {
    segments.push(persona)
  }

  // 2. Shared memory (global long-term + daily, read-only)
  const sharedMemory = this.readSharedMemory()
  if (sharedMemory) {
    segments.push(sharedMemory)
  }

  // 3. Clone's own memory (always loaded, regardless of memoryScope)
  const ownMemory = this.readOwnMemory()
  if (ownMemory) {
    segments.push(ownMemory)
  }

  // 4. Memory & persona management guidance
  const guidance = this.getMemoryGuidance()
  if (guidance) {
    segments.push(guidance)
  }

  return segments.filter(Boolean).join('\n\n')
}
```

### 8.3 SystemPromptAssembler 预算截断（当前）

```typescript
// packages/server/src/services/agent/system-prompt-assembler.ts:489-520
truncateToBudget(segments: PromptSegment[], maxTokens: number): PromptSegment[] {
  const sorted = [...segments].sort((a, b) => a.priority - b.priority)

  // Phase 1: Apply segment-specific degradation rules
  const degraded = sorted.map((seg) => this.applyDegradationRule(seg, maxTokens))

  // Phase 2: Fit into budget by priority
  const result: PromptSegment[] = []
  let usedTokens = 0

  for (const segment of degraded) {
    if (usedTokens + segment.tokenEstimate <= maxTokens) {
      result.push(segment)
      usedTokens += segment.tokenEstimate
    } else {
      const remainingTokens = maxTokens - usedTokens
      if (remainingTokens > 50) {
        const maxChars = remainingTokens * CHARS_PER_TOKEN
        const truncated = {
          ...segment,
          content: segment.content.slice(0, maxChars) + '\n\n[... truncated ...]',
          tokenEstimate: remainingTokens,
        }
        result.push(truncated)
        usedTokens += remainingTokens
      }
      break
    }
  }

  return result
}
```

---

## 9. 结论

### 9.1 核心发现

1. **两个系统独立且互补**: WorkflowEngine AgentExecutor（临时任务）vs Clone Agent（持久身份）
2. **完全合并不推荐**: 过度设计，破坏架构分层，收益不明显
3. **能力注入是最佳路径**: 渐进式、低耦合、灵活性高
4. **Harness 模式可行**: Tool 拦截器 + 测试专用配置可解决 E2E 问题

### 9.2 下一步行动

1. **短期** (1 周): 实现 Memory Context Injection POC
2. **中期** (2-4 周): 实现 Skills Discovery + YAML 配置语法
3. **长期** (1-2 月): 评估是否需要更紧密的整合（基于使用数据）

### 9.3 开放问题

- Memory context 应该从哪个 clone 读取？（workspace? 专用 workflow-executor clone?）
- Skills 过滤的默认白名单应该包含哪些？
- 是否需要工作流级别的 memory（跨执行持久化）？
- Harness 模式的 tool 拦截器应该放在 provider 层还是 engine 层？

---

**报告完成时间**: 2026-08-04
**预计阅读时间**: 15 分钟
**建议讨论范围**: 架构评审会议
