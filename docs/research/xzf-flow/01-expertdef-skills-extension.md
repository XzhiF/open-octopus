# ExpertDef Skills 扩展设计

## 背景

SwarmExecutor 当前不支持在专家定义（ExpertDef）上指定 `skills`。`skills` 字段仅存在于：
- `NodeDef.skills` — agent 类型节点
- `SubAgentDef.skills` — agent 节点内的子代理

但 `ClaudeSDKProvider.sendQuery()` 的 `SendQueryOptions` 已支持 `skills?: string[]` 参数，会直接传递给 Claude SDK 的 `query()` 函数。

## 目标

让 swarm 节点的每个专家可以独立配置 skills，通过 `expert.skills` 传递到 provider 层。

## 当前类型定义

### ExpertDefSchema (packages/shared/src/types/swarm.ts, line 4-18)

```typescript
export const ExpertDefSchema = z.object({
  role: z.string(),
  agent_file: z.string().optional(),
  prompt: z.string().optional(),
  perspective: z.string().optional(),
  task: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  // ❌ 无 skills 字段
}).refine(...)
```

### 对比：SubAgentDef 已支持 skills

```typescript
export const SubAgentDefSchema = z.object({
  // ...
  skills: z.array(z.string()).optional(),  // ✅ 已有
  // ...
})
```

### Provider 层已支持

```typescript
// packages/providers/src/types.ts
export interface SendQueryOptions {
  skills?: string[]  // ✅ 已有
}

// packages/providers/src/claude/provider.ts
const sdkOptions: Options = {
  skills: options?.skills,  // ✅ 直接传递给 Claude SDK
}
```

## 注入链路分析

完整调用链：

```
ExpertDef.skills (YAML)
  → SwarmCoordinator.runExpert(expert, prompt, round)
    → deps.llmCall(prompt, model, engine, skills)
      → collectFromProvider(provider, prompt, cwd, model, skills)
        → provider.sendQuery(prompt, cwd, undefined, { model, skills })
          → Claude SDK query({ prompt, options: { skills } })
```

## 4 个注入点

### 注入点 1: ExpertDefSchema

**文件**: `packages/shared/src/types/swarm.ts`

添加 `skills` 字段到 ExpertDefSchema：

```typescript
export const ExpertDefSchema = z.object({
  role: z.string(),
  agent_file: z.string().optional(),
  prompt: z.string().optional(),
  perspective: z.string().optional(),
  task: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  skills: z.array(z.string()).optional(),  // 新增
}).refine(...)
```

同时在 `SwarmNodeDefSchema` 的 `expert_defaults` 中也添加：

```typescript
expert_defaults: z.object({
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),  // 新增
}).optional(),
```

### 注入点 2: collectFromProvider()

**文件**: `packages/engine/src/executors/swarm.ts` (~line 496)

当前签名：
```typescript
async function collectFromProvider(
  provider: IAgentProvider,
  prompt: string,
  cwd: string,
  model?: string,
): Promise<{...}> {
  const gen = provider.sendQuery(prompt, cwd, undefined, {
    model,
    systemPrompt: "You are an expert assistant.",
    // ❌ 无 skills
  })
}
```

修改为：
```typescript
async function collectFromProvider(
  provider: IAgentProvider,
  prompt: string,
  cwd: string,
  model?: string,
  skills?: string[],  // 新增
): Promise<{...}> {
  const gen = provider.sendQuery(prompt, cwd, undefined, {
    model,
    systemPrompt: "You are an expert assistant.",
    skills,  // 新增
  })
}
```

### 注入点 3: llmCall 闭包

**文件**: `packages/engine/src/executors/swarm.ts` (~line 132)

当前签名：
```typescript
const llmCall = async (
  prompt: string,
  model?: string,
  engine?: string,
): Promise<{...}> => {
  const p = resolveProviderForExpert(engine)
  const result = await collectFromProvider(p, prompt, this.cwd, resolvedModel)
}
```

修改为：
```typescript
const llmCall = async (
  prompt: string,
  model?: string,
  engine?: string,
  skills?: string[],  // 新增
): Promise<{...}> => {
  const p = resolveProviderForExpert(engine)
  const result = await collectFromProvider(p, prompt, this.cwd, resolvedModel, skills)
}
```

### 注入点 4: SwarmCoordinator.runExpert()

**文件**: `packages/engine/src/executors/swarm/swarm-coordinator.ts` (~line 74)

当前：
```typescript
async runExpert(expert: ExpertDef, prompt: string, round: number): Promise<ExpertOutput> {
  const result = await this.deps.llmCall(prompt, model, expert.engine)
}
```

修改为：
```typescript
async runExpert(expert: ExpertDef, prompt: string, round: number): Promise<ExpertOutput> {
  const result = await this.deps.llmCall(prompt, model, expert.engine, expert.skills)
}
```

### SwarmServices 接口

**文件**: `packages/engine/src/executors/swarm/swarm-strategy.ts`

`runExpert` 接口签名无需修改 — 它接收 `expert: ExpertDef`，skills 已在 ExpertDef 内部。

## YAML 使用示例

```yaml
# expert_defaults 级别 — 所有专家共享
- id: brainstorm
  type: swarm
  mode: debate
  expert_defaults:
    skills:
      - octo-xzf-clarify

# expert 级别 — 每个专家独立配置
  experts:
    - role: senior-architect
      agent_file: .claude/agents/octo-xzf-architect.md
      skills:
        - octo-xzf-spec-designer
    - role: test-architect
      agent_file: .claude/agents/octo-xzf-test-architect.md
      skills:
        - octo-xzf-spec-designer
        - octo-xzf-implementer
```

## 合并策略

当 expert_defaults 和 expert 都定义了 skills 时：

```
expert_defaults.skills = [A, B]
expert.skills = [C]
→ 最终 expert.skills = [A, B, C]  // 合并
```

在 SwarmExecutor.execute() 的 baseExperts 合并逻辑中处理：

```typescript
const baseExperts: ExpertDef[] = (this.node.experts ?? []).map(e => ({
  ...this.node.expert_defaults,
  ...e,
  skills: [
    ...(this.node.expert_defaults?.skills ?? []),
    ...(e.skills ?? []),
  ],
}))
```

## 测试要点

1. ExpertDefSchema 验证：skills 字段可选、类型为 string[]
2. expert_defaults.skills 正确合并到每个 expert
3. expert.skills 优先级高于 expert_defaults（合并而非覆盖）
4. collectFromProvider 正确传递 skills 到 provider.sendQuery
5. 无 skills 时不影响现有行为（向后兼容）

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `packages/shared/src/types/swarm.ts` | Schema 扩展 |
| `packages/engine/src/executors/swarm.ts` | 函数签名 + 参数传递 |
| `packages/engine/src/executors/swarm/swarm-coordinator.ts` | 参数传递 |
| 策略文件 (discussion/dispatch/moa) | **无需修改** — 已通过 ExpertDef 传递 |
