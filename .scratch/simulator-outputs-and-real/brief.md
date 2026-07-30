# Requirement Brief: 模拟器 outputs 共享函数 + --real 实现 + fixture 修复

## Overview
修复模拟器与真实引擎的 `outputs:` 映射行为差异（提取共享函数），实现 `simulate --real` 真实执行 bash/python 节点（超时保护），并修复 xzf-dev.test.yaml 让所有 scenario 通过。

## Projects Involved
- [ ] `packages/shared` (新增 `outputs-resolver.ts` — 共享 outputs 映射处理函数)
- [ ] `packages/engine` (模拟器 `applyNodeOutputsMapping` 改用共享函数; mock-factory 实现 `--real`)
- [ ] `packages/core-pack` (修复 `xzf-dev.test.yaml` fixture)

## Feature Scope

**Do:**
- 提取 `resolveOutputsExpression()` 共享函数到 `@octopus/shared`
  - 处理: `$last_output`, `$last_output.field` (JSON.parse), `$exit_code`, `$vars.xxx = expr` (evaluateExpression), `$vars.xxx` (substituteVars), 字面量
  - 参数化: lastOutput, exitCode, pool, nodeOutputs
- 模拟器的 `applyNodeOutputsMapping` 改用共享函数
- 真实引擎的 4 个 executor (bash/agent/python/approval) 的 `applyOutputsMapping` 改用共享函数
- 实现 `simulate --real <node-ids>` — mock-factory 对指定节点返回真实 BashExecutor/PythonExecutor
- 修复 `xzf-dev.test.yaml` — 3 个 scenario 全部通过

**Don't:**
- 新建沙箱/容器隔离（信任模型 + 超时保护）
- 修改 `substituteVars` / `evaluateExpression` 本身
- 修改模拟器引擎的其他部分 (condition/loop/DAG)
- Web UI / Server 改动

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | outputs 修复策略 | 提取共享函数 (非复制) | 防止行为漂移，单一事实来源 |
| 2 | `--real` 安全模型 | 超时保护即可 | AI 生成脚本大体可信，沙箱工程量大 |
| 3 | outputs 测试策略 | 先修行为差异，不单独加测试 | 现有 golden workflow 测试自然覆盖 |
| 4 | 共享函数位置 | `@octopus/shared` | engine 和 simulator 都依赖 shared |

## 发现的 Bug

### Bug #1: 模拟器 vs 真实引擎 outputs 行为差异

| 表达式 | 真实引擎 | 模拟器 | 修复后 (共享函数) |
|--------|---------|--------|------------------|
| `$last_output` | ✅ direct assign | ✅ direct assign | ✅ |
| `$last_output.field` | ✅ JSON.parse + extract | ❌ substituteVars (不认识) | ✅ |
| `$exit_code` | ✅ direct assign | ❌ 无处理 | ✅ |
| `$vars.x = expr` | ✅ evaluateExpression | ❌ 无处理 | ✅ |
| `$vars.x + 1` (via evaluateExpression) | ✅ 算术求值 | ❌ 字符串 | ✅ |

### Bug #2: 真实引擎 executor 之间也不一致

| Executor | nodeOutputs 传给 substituteVars | 后果 |
|----------|-------------------------------|------|
| bash.ts | `undefined` | `$nodeId.output.key` 不解析 |
| agent.ts | `this.buildNodeOutputs()` | `$nodeId.output.key` 解析 |
| python.ts | `undefined` | 同 bash |
| approval.ts | `undefined` | 同 bash |

**修复**: 共享函数统一传 `undefined`（`$nodeId.output.key` 不是 outputs DSL 文档中的合法语法）。

## API Contracts

### 共享函数签名

```typescript
// packages/shared/src/variables/outputs-resolver.ts

/**
 * Resolve a single expression in a node's `outputs:` mapping.
 * Shared between real engine executors and the simulator.
 *
 * @param expr - The expression string from outputs mapping
 * @param pool - VarPool for reading/writing variables
 * @param lastOutput - The node's lastOutput (stdout for bash/python, text for agent)
 * @param exitCode - The node's exit code (bash/python only, undefined for others)
 * @returns The resolved value to write to VarPool
 */
export function resolveOutputsExpression(
  expr: string,
  pool: VarPool,
  lastOutput: string | undefined,
  exitCode: number | undefined,
): unknown

/**
 * Process a node's full `outputs:` mapping block.
 * Iterates over all key-value pairs, resolves each, writes to VarPool.
 *
 * @param outputs - The node's outputs mapping (from YAML `outputs:` block)
 * @param pool - VarPool
 * @param lastOutput - Node's lastOutput
 * @param exitCode - Node's exit code
 * @returns Record of resolved key-value pairs
 */
export function applyOutputsMapping(
  outputs: Record<string, string>,
  pool: VarPool,
  lastOutput: string | undefined,
  exitCode: number | undefined,
): Record<string, unknown>
```

### `--real` 实现

```typescript
// packages/engine/src/simulator/mock-factory.ts

// 修改前 (throw):
if (realExecution.has(node.id)) {
  throw new Error(`Real execution for node ${node.id} is not yet supported`)
}

// 修改后:
if (this.realExecution.has(node.id)) {
  if (node.type === 'bash') return new BashExecutor(node, this.pool, { ... })
  if (node.type === 'python') return new PythonExecutor(node, this.pool, { ... })
  throw new Error(`--real only supports bash/python nodes, got: ${node.type}`)
}
```

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 模拟器和真实引擎的 outputs 行为一致 | `$last_output.field` / `$exit_code` / `$vars.x = expr` 在模拟器中正确解析 | 单元测试: resolveOutputsExpression 各表达式类型 |
| 2 | 真实引擎 executor 行为不变 | bash/agent/python/approval 的 outputs 映射结果与修改前相同 | `pnpm test` 现有测试全部通过 |
| 3 | `simulate --real bash-node` 真实执行 | 指定 bash 节点在宿主机执行，stdout 写入 VarPool | 手动: 创建含 `echo "hello"` 的 bash 节点 → --real → 检查 pool |
| 4 | `simulate --real` 超时保护 | 脚本超过 timeout 被 kill | 手动: 创建 `sleep 60` 脚本 + timeout: 5 → 验证被 kill |
| 5 | `simulate --real python-node` 真实执行 | 指定 python 节点在宿主机执行 | 手动: 创建 `print("hello")` → --real → 检查 pool |
| 6 | xzf-dev.test.yaml 全部通过 | 3 个 scenario 全部 PASS | `octopus workflow test xzf-dev.yaml` → 0 failed |
| 7 | simulate 命令不受影响 | `simulate` 输出不变 | 手动对比 |

## Verification Strategy

### Unit Tests
- `resolveOutputsExpression` 各表达式类型:
  - `$last_output` → 返回 lastOutput
  - `$last_output.name` → JSON.parse lastOutput → 返回 .name
  - `$exit_code` → 返回 exitCode
  - `$vars.count = $vars.count + 1` → evaluateExpression → 返回计算结果
  - `$vars.xxx` → substituteVars → 返回 pool 值
  - `"literal"` → 返回字面量
  - 非 JSON 的 `$last_output.field` → 返回 undefined

### Integration Tests
- `pnpm test` — 现有 65 个模拟器测试 + 19 个 SSE 测试全部通过
- 新增 golden workflow 覆盖 `$last_output.field` 和 `$exit_code`

### Manual Checklist
| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | --real bash | 创建 echo 脚本 + `--real bash-1` | stdout 写入 VarPool |
| 2 | --real python | 创建 print 脚本 + `--real py-1` | stdout 写入 VarPool |
| 3 | --real timeout | `sleep 60` + timeout: 5 | 5s 后被 kill |
| 4 | xzf-dev 通过 | `workflow test xzf-dev.yaml` | 3/3 PASS |

### Prerequisites
- [ ] `pnpm build` 成功
- [ ] bash / python3 可用

## Changed Files 预估

| Package | File | Change |
|---------|------|--------|
| shared | `src/variables/outputs-resolver.ts` | New: 共享函数 |
| shared | `src/index.ts` | Export 新函数 |
| engine | `src/simulator/simulator-engine.ts` | `applyNodeOutputsMapping` → 调用共享函数 |
| engine | `src/executors/bash.ts` | `applyOutputsMapping` → 调用共享函数 |
| engine | `src/executors/agent.ts` | 同上 |
| engine | `src/executors/python.ts` | 同上 |
| engine | `src/executors/approval.ts` | 同上 |
| engine | `src/simulator/mock-factory.ts` | 实现 `--real` (返回真实 executor) |
| engine | `src/__tests__/outputs-resolver.test.ts` | New: 共享函数单测 |
| core-pack | `workflows/xzf-dev.test.yaml` | 修复 fixture 数据 |

## Risks & Notes

- **R1: 真实引擎 executor 行为微调** — 改用共享函数后，4 个 executor 的 `applyOutputsMapping` 行为统一。bash executor 之前传 `undefined` 给 nodeOutputs，改用共享函数后也不传（保持一致）。如果有工作流依赖了 bash executor 的 `$nodeId.output.key` 不解析的行为，可能会有影响。
- **R2: `--real` 安全** — 脚本在宿主机直接执行，无沙箱。用户需信任 AI 生成的脚本内容。超时保护是唯一的边界。
- **R3: xzf-dev.test.yaml 可能需要大量修改** — 如果 outputs 行为差异是 fixture 失败的根因，修复共享函数后 fixture 可能自然通过。否则需要手动调整 mock 数据。

## Glossary

| Term | Meaning |
|------|---------|
| **outputs 共享函数** | `resolveOutputsExpression()` / `applyOutputsMapping()` — 统一处理 `outputs:` 映射表达式的函数，被模拟器和真实引擎共同使用 |
| **行为差异** | 模拟器和真实引擎对同一 `outputs:` 表达式产生不同 VarPool 结果的 bug |
| **`--real`** | `simulate` 命令的标志，将指定 bash/python 节点从 mock 升级为真实执行 |
