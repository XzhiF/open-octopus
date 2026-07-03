# 第七章：模型别名路由策略（pro-max / pro / se）

> 状态：设计完成，待实现
> 优先级：高（影响所有工作流 YAML 的 model 字段写法）

---

## 7.1 设计动机

当前工作流 YAML 中 `model` 字段直接写具体模型名（如 `"sonnet"`、`"gpt-4o"`），导致：

1. **Provider 绑定** — 同一个工作流无法在 ClaudeSDKProvider 和 PiAgentProvider 之间切换而不改 model
2. **语义不清** — `"sonnet"` 到底是什么意思？是"中等能力的模型"还是"Claude Sonnet"？
3. **难以升级** — 当 Anthropic 发布新模型时，所有 YAML 都需要改

### 解决思路

引入三层模型别名（参考手机命名），**按 provider 解析为不同的真实模型**：

| 别名 | 语义 | ClaudeSDKProvider | PiAgentProvider（示例） |
|------|------|-------------------|----------------------|
| `pro-max` | 最强推理 | opus | anthropic/claude-opus-4-20250514 |
| `pro` | 平衡能力与速度 | sonnet | anthropic/claude-sonnet-4-20250514 |
| `se` | 轻量快速 | haiku | anthropic/claude-haiku-4-5-20251001 |

Pi 的映射**由用户配置**（`~/.octopus/models.yaml`），因为 Pi 支持 40+ 提供商，不同用户偏好不同。

---

## 7.2 配置文件

### 文件位置

```
~/.octopus/models.yaml          ← 全局配置（所有 org 共享）
~/.octopus/orgs/{org}/models.yaml  ← 可选：org 级覆盖
```

**查找顺序**：org 级 → 全局 → 内置默认值。找到第一个存在的文件后停止。

### 配置文件格式

```yaml
# ~/.octopus/models.yaml
# 模型别名路由配置
# 别名: pro-max（最强）/ pro（平衡）/ se（轻量）

# 当 YAML 中未指定 model 时使用的默认 tier
default: pro

# 每个 provider 的 tier → 真实模型映射
providers:

  claude:
    pro-max: opus
    pro: sonnet
    se: haiku

  pi:
    pro-max: anthropic/claude-opus-4-20250514
    pro: anthropic/claude-sonnet-4-20250514
    se: anthropic/claude-haiku-4-5-20251001

    # ─── 其他 Pi 提供商示例（按需取消注释）───
    # pro-max: openai/o3
    # pro: openai/gpt-4o
    # se: openai/gpt-4o-mini

    # pro-max: google/gemini-2.5-pro
    # pro: google/gemini-2.5-flash
    # se: google/gemini-2.0-flash

    # pro-max: deepseek/deepseek-reasoner
    # pro: deepseek/deepseek-chat
    # se: deepseek/deepseek-chat
```

### 内置默认值（当没有配置文件时）

```typescript
const DEFAULT_MODEL_ALIASES: ModelAliasConfig = {
  default: "pro",
  providers: {
    claude: {
      "pro-max": "opus",
      "pro": "sonnet",
      "se": "haiku",
    },
    pi: {
      "pro-max": "anthropic/claude-opus-4-20250514",
      "pro": "anthropic/claude-sonnet-4-20250514",
      "se": "anthropic/claude-haiku-4-5-20251001",
    },
  },
}
```

---

## 7.3 解析规则

### 输入 → 输出

| 输入 model 值 | provider | 解析结果 | 说明 |
|---|---|---|---|
| `"pro-max"` | claude | `"opus"` | 匹配 tier，查 claude 映射 |
| `"pro"` | pi | `"anthropic/claude-sonnet-4-20250514"` | 匹配 tier，查 pi 映射 |
| `"sonnet"` | claude | `"sonnet"` | 不是 tier，原样传递 |
| `"openai/gpt-4o"` | pi | `"openai/gpt-4o"` | 不是 tier，原样传递 |
| `"pro-max"` | custom | `"pro-max"` | provider 无映射，原样传递 |
| `undefined` | claude | `"sonnet"` | 无 model，使用 default tier → 解析 |
| `undefined` | pi | `"anthropic/claude-sonnet-4-20250514"` | 无 model，使用 default tier → 解析 |

### 解析流程

```
resolveModelAlias(model, providerType, config)
  │
  ├─ model 为空?
  │    └─ YES → 取 config.default tier，继续
  │
  ├─ model 是 "pro-max" | "pro" | "se"?
  │    ├─ YES → 查 config.providers[providerType][tier]
  │    │         ├─ 找到 → 返回映射值
  │    │         └─ 未找到 → 返回 model 原值（兼容）
  │    │
  │    └─ NO → 返回 model 原值（非 tier，不做转换）
  │
  └─ config 未加载?
       └─ 使用 DEFAULT_MODEL_ALIASES
```

---

## 7.4 数据流（完整链路）

### 现有链路（不变）

```
YAML node.model: "pro-max"
         │
         ▼
WorkflowEngine.constructor()
  → propagateModel(nodes, workflow.model)   // 向下传递 tier 字符串
         │
         ▼
WorkflowEngine.createExecutor(node)          // ← 在这里插入解析
  → providerKey = node.engine ?? "claude"
  → ★ node.model = resolveModelAlias(node.model, providerKey, config) ★
  → new AgentExecutor(node, ...)             // node.model 已是真实模型名
         │
         ▼
AgentExecutor.execute()
  → runner.run({ model: this.node.model })   // 传递真实模型名
         │
         ▼
AgentNodeRunner.run()
  → provider.sendQuery(prompt, cwd, sid, { model: opts.model })
         │
         ▼
Provider（收到的是真实模型名，无需知道 tier 概念）
```

### SwarmExecutor 链路

```
YAML swarm node:
  experts:
    - name: expert-a
      model: "pro-max"       ← tier
    - name: expert-b
      model: "pro"           ← tier
  host:
    model: "pro-max"         ← tier

         │
         ▼
WorkflowEngine.createExecutor(node)  // type: "swarm"
  → providerKey = node.engine ?? "claude"
  → ★ 对每个 expert.model 调用 resolveModelAlias ★
  → ★ 对 host.model 调用 resolveModelAlias ★
  → new SwarmExecutor(node, ...)
         │
         ▼
SwarmCoordinator / HostAgent（收到的是已解析的真实模型名）
```

---

## 7.5 代码变更清单

### 文件 1：`packages/shared/src/types/config.ts`

**新增类型定义**：

```typescript
export const ModelTierSchema = z.enum(["pro-max", "pro", "se"])

export const ModelAliasConfigSchema = z.object({
  default: ModelTierSchema.optional().default("pro"),
  providers: z.record(z.string(), z.record(z.string(), z.string())),
})

export type ModelTier = z.infer<typeof ModelTierSchema>
export type ModelAliasConfig = z.infer<typeof ModelAliasConfigSchema>
```

### 文件 2：`packages/shared/src/config/model-alias.ts`（新建）

```typescript
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import yaml from "js-yaml"
import { ModelAliasConfigSchema, type ModelAliasConfig } from "../types/config"
import { resolveGlobalDir, resolveOrgDir } from "./loader"

const TIERS = ["pro-max", "pro", "se"] as const

const DEFAULT_CONFIG: ModelAliasConfig = {
  default: "pro",
  providers: {
    claude: { "pro-max": "opus", "pro": "sonnet", "se": "haiku" },
    pi: {
      "pro-max": "anthropic/claude-opus-4-20250514",
      "pro": "anthropic/claude-sonnet-4-20250514",
      "se": "anthropic/claude-haiku-4-5-20251001",
    },
  },
}

/** 加载 models.yaml 配置（org 级 > 全局 > 内置默认） */
export function loadModelAliasConfig(org?: string): ModelAliasConfig {
  // 1. 尝试 org 级
  if (org) {
    const orgPath = join(resolveOrgDir(org), "models.yaml")
    if (existsSync(orgPath)) return parseConfigFile(orgPath)
  }
  // 2. 尝试全局
  const globalPath = join(resolveGlobalDir(), "models.yaml")
  if (existsSync(globalPath)) return parseConfigFile(globalPath)
  // 3. 内置默认
  return DEFAULT_CONFIG
}

function parseConfigFile(filePath: string): ModelAliasConfig {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = yaml.load(raw)
    const result = ModelAliasConfigSchema.safeParse(parsed)
    return result.success ? result.data : DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG
  }
}

/** 解析模型别名：tier → 真实模型名，非 tier 原样返回 */
export function resolveModelAlias(
  model: string | undefined,
  providerType: string,
  config: ModelAliasConfig,
): string | undefined {
  // 无 model → 用 default tier
  const effectiveModel = model ?? config.default

  // 不是 tier → 原样返回
  if (!TIERS.includes(effectiveModel as any)) {
    return effectiveModel
  }

  // 是 tier → 查 provider 映射
  const providerMap = config.providers[providerType]
  if (!providerMap) return effectiveModel

  return providerMap[effectiveModel] ?? effectiveModel
}

/** 检查 model 字符串是否是 tier 别名 */
export function isModelTier(model: string): boolean {
  return TIERS.includes(model as any)
}

/** 获取内置默认配置（用于测试） */
export function getDefaultModelAliasConfig(): ModelAliasConfig {
  return structuredClone(DEFAULT_CONFIG)
}
```

### 文件 3：`packages/shared/src/index.ts`

**新增 export**：

```typescript
export * from "./config/model-alias"
```

### 文件 4：`packages/engine/src/engine.ts`

**变更 1**：构造函数中加载配置（约 line 160）

```typescript
// 现有代码之后追加：
import { loadModelAliasConfig, resolveModelAlias, type ModelAliasConfig } from "@octopus/shared"

class WorkflowEngine {
  // 新增字段
  private modelAliasConfig: ModelAliasConfig

  constructor(...) {
    // ... 现有代码 ...

    // 加载模型别名配置
    this.modelAliasConfig = loadModelAliasConfig(this.org)

    // Propagate workflow-level model（现有代码不变）
    if (workflow.model) {
      this.propagateModel(workflow.nodes, workflow.model)
    }
  }
}
```

**变更 2**：`createExecutor()` 的 agent case（约 line 1345）

```typescript
case "agent": {
  const rawKey = node.engine ?? "claude"
  const providerKey = rawKey === "claude-code" ? "claude" : rawKey
  const provider = this.providers[providerKey]
  if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

  // ★ 新增：解析模型别名 ★
  node.model = resolveModelAlias(node.model, providerKey, this.modelAliasConfig)

  const runner = new AgentNodeRunner(provider, this.cwd, (event) => { ... })
  // ... 后续不变
}
```

**变更 3**：`createExecutor()` 的 swarm case（约 line 1369）

```typescript
case "swarm": {
  // ★ 新增：解析 swarm expert 和 host 的模型别名 ★
  const swarmProviderKey = node.engine ?? "claude"
  if (node.experts) {
    for (const expert of node.experts) {
      expert.model = resolveModelAlias(expert.model, swarmProviderKey, this.modelAliasConfig)
    }
  }
  if (node.host?.model) {
    node.host.model = resolveModelAlias(node.host.model, swarmProviderKey, this.modelAliasConfig)
  }

  return new SwarmExecutor(node, p, this.providers, this.cwd, ...)
}
```

**变更 4**：`propagateModel()` 不需要改

`propagateModel` 只是将 workflow-level model 复制到没有自己 model 的 agent 节点。tier 字符串（如 `"pro-max"`）会被原样传递，然后在 `createExecutor()` 中被解析。这是正确的行为。

---

## 7.6 兼容性分析

### 向后兼容

| 场景 | 行为 |
|------|------|
| YAML 写 `model: "sonnet"` | 不是 tier，原样传递，行为不变 ✅ |
| YAML 写 `model: "opus"` | 不是 tier，原样传递，行为不变 ✅ |
| YAML 写 `model: "openai/gpt-4o"` | 不是 tier，原样传递 ✅ |
| YAML 写 `model: "pro"` | 匹配 tier，解析为真实模型 ✅ |
| YAML 不写 model | 使用 `config.default`（默认 `"pro"`），解析 ✅ |
| 没有 `~/.octopus/models.yaml` | 使用内置默认值 ✅ |
| 使用未知 provider | tier 无法解析，原样传递 ✅ |

### 不影响的部分

- `AgentNodeRunner` — 收到的已是解析后的模型名
- `Provider` — 不感知 tier 概念
- `SwarmCoordinator` — 收到的已是解析后的模型名
- `HostAgent` — 收到的已是解析后的模型名
- `AgentExecutor.buildPrompt()` — 不使用 model 字段

---

## 7.7 YAML 使用示例

### 基本用法

```yaml
apiVersion: octopus/v1
kind: Workflow
name: tier-demo
engine: claude        # 使用 ClaudeSDKProvider
model: pro            # ← tier 别名，解析为 "sonnet"

nodes:
  - id: deep-analysis
    type: agent
    model: pro-max    # ← 解析为 "opus"
    prompt: "Perform deep security analysis..."

  - id: quick-review
    type: agent
    model: se         # ← 解析为 "haiku"
    prompt: "Quick code style check..."

  - id: implementation
    type: agent
    model: pro        # ← 解析为 "sonnet"（继承 workflow-level）
    prompt: "Implement the fixes..."
```

### 混合 Provider

```yaml
apiVersion: octopus/v1
kind: Workflow
name: multi-provider
execution_mode: auto

nodes:
  # Claude provider + tier
  - id: analyze
    type: agent
    engine: claude
    model: pro          # → "sonnet"
    prompt: "Analyze..."

  # Pi provider + 同一个 tier → 不同的模型
  - id: review
    type: agent
    engine: pi
    model: pro          # → "anthropic/claude-sonnet-4-20250514"
    depends_on: [analyze]
    prompt: "Review..."

  # Pi provider + 直接写模型名（不经过 tier 解析）
  - id: summarize
    type: agent
    engine: pi
    model: openai/gpt-4o  # → "openai/gpt-4o"（不是 tier，原样传递）
    depends_on: [review]
    prompt: "Summarize..."
```

### Swarm + Tier

```yaml
nodes:
  - id: debate
    type: swarm
    engine: pi
    mode: debate
    rounds: 2
    topic: "Microservices vs Monolith?"
    experts:
      - name: architect
        model: pro-max      # → pi: "anthropic/claude-opus-4-20250514"
      - name: pragmatist
        model: pro           # → pi: "anthropic/claude-sonnet-4-20250514"
    host:
      model: pro-max        # → pi: "anthropic/claude-opus-4-20250514"
```

---

## 7.8 测试策略

### 单元测试（不需要 API Key）

```
packages/shared/src/__tests__/model-alias.test.ts
```

| 测试用例 | 输入 | 预期输出 |
|----------|------|----------|
| tier 解析 claude pro-max | `("pro-max", "claude", config)` | `"opus"` |
| tier 解析 claude pro | `("pro", "claude", config)` | `"sonnet"` |
| tier 解析 claude se | `("se", "claude", config)` | `"haiku"` |
| tier 解析 pi pro | `("pro", "pi", config)` | `"anthropic/claude-sonnet-4-20250514"` |
| 非 tier 原样返回 | `("sonnet", "claude", config)` | `"sonnet"` |
| 非 tier 含斜杠 | `("openai/gpt-4o", "pi", config)` | `"openai/gpt-4o"` |
| provider 无映射 | `("pro", "custom", config)` | `"pro"` |
| undefined 使用 default | `(undefined, "claude", config)` | `"sonnet"` |
| undefined 使用 default pi | `(undefined, "pi", config)` | `"anthropic/claude-sonnet-4-20250514"` |
| 自定义 config 覆盖 | `("pro", "pi", customConfig)` | 自定义值 |
| 配置文件加载 | 写临时 YAML → `loadModelAliasConfig()` | 正确解析 |
| 配置文件缺失 | 无文件 → `loadModelAliasConfig()` | 返回默认值 |
| 配置文件格式错误 | 损坏的 YAML → `loadModelAliasConfig()` | 返回默认值 |

### 集成测试

```
packages/engine/src/__tests__/model-alias-integration.test.ts
```

| 测试用例 | 描述 |
|----------|------|
| propagateModel + resolveModelAlias | workflow.model="pro" → agent.node.model 解析后为真实名 |
| swarm expert tier 解析 | expert.model="pro-max" → 解析后传入 SwarmExecutor |
| swarm host tier 解析 | host.model="pro" → 解析后传入 HostAgent |

---

## 7.9 实现顺序

此模块独立于 Pi Provider 集成，可以单独先行实现：

| 步骤 | 文件 | 工作量 |
|------|------|--------|
| 1 | `shared/src/types/config.ts` — 新增 Schema 和 type | 5 min |
| 2 | `shared/src/config/model-alias.ts` — 新建 resolver | 30 min |
| 3 | `shared/src/index.ts` — 添加 export | 1 min |
| 4 | `shared/src/__tests__/model-alias.test.ts` — 单元测试 | 30 min |
| 5 | `engine/src/engine.ts` — 集成 resolver（4 处变更） | 20 min |
| 6 | `engine/src/__tests__/model-alias-integration.test.ts` — 集成测试 | 30 min |
| 7 | `~/.octopus/models.yaml` — 创建默认配置文件 | 5 min |

**总计**：约 2 小时

---

## 7.10 与 Pi 集成的关系

模型别名系统与 Pi Provider 集成是**正交**的：

```
                    ┌─ ClaudeSDKProvider
                    │    model: "opus" (解析后)
YAML model: "pro" →│
                    │
                    └─ PiAgentProvider
                         model: "anthropic/claude-sonnet-4-20250514" (解析后)
```

- **先实现模型别名** → 现有 ClaudeSDKProvider 立刻受益（YAML 可写 `pro` 代替 `sonnet`）
- **再实现 Pi Provider** → 自动支持 tier（因为解析在 engine 层完成）
- 两者互不依赖，可独立实现和测试
