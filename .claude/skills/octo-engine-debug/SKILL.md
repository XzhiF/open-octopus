---
name: octo-engine-debug
description: Use when debugging Octopus workflow engine issues — approval dialogs not appearing, nodes not executing, variables not resolving, SSE events lost, infinite loops, or UI state desync. Applies to ExecutionLifecycle, LoopExecutor, SSE pipeline, and variable substitution chain.
---

# Octopus 引擎调试方法论

## 概述

五层排查法：日志 → SSE → 数据流 → 代码对比 → 变量链。从用户症状出发，逐层缩小范围，用证据替代猜测。

## 何时使用

- 审批弹窗/按钮不出现，刷新后才显示
- 节点执行了但没有日志
- 变量 `$nodeId.output` 未解析，agent 收到原始占位符
- 工作流无限循环或迭代数不递增
- approve/retry 后 UI 卡在"提交中"
- SSE 事件发了但前端没响应

## 第一层：JSONL 日志分析

**目标**：确认节点是否真正执行。

```bash
# 定位日志目录
ls ~/.octopus/{org}/workspaces/{ws}/logs/{execId}/

# 检查目标节点是否有日志文件
# 有 → 执行过，看内容
# 没有 → 根本没执行，或 logger 没写
cat ~/.octopus/.../logs/{execId}/{nodeId}.jsonl
```

**关键判断**：

| 文件存在 | 内容 | 结论 |
|----------|------|------|
| ✅ | 有 start/end 事件 | 节点正常执行 |
| ✅ | 只有 start，无 end | 节点执行中崩溃或挂起 |
| ❌ | 不存在 | 节点未执行，或 logger 未调用 |

**常见陷阱**：Loop 内部节点的 `logger.log()` 可能缺失。对比顶层节点（engine.ts `executeNode` 有 logger）和循环内部节点（loop.ts `createExecutor` 可能遗漏 logger 调用）。

## 第二层：SSE 事件追踪

**目标**：确认事件从服务端到前端的完整链路。

### 服务端 emit 点

```bash
# 搜索所有 SSE 发射点
grep -n "sse.emit" packages/server/src/services/execution/ExecutionLifecycle.ts
```

**检查同一事件是否有多个 emit 点**。多个 emit 点可能发送不同的 payload — 先发的有完整数据，后发的可能缺字段，导致覆盖。

### 客户端 listener

```bash
# 搜索 SSE 监听器
grep -n "addEventListener" packages/web-app/hooks/use-execution-tree.ts
```

**检查 handler 是否无条件覆盖状态**：

```typescript
// ❌ 错误：后来的事件覆盖前面的有效数据
approvalMetadata: approval  // approval 可能是 undefined

// ✅ 正确：仅在有新数据时覆盖
...(approval ? { approvalMetadata: approval } : {})
```

### 事件时序

```
emit A (完整数据) → emit B (缺字段) → handler 用 undefined 覆盖 → UI 丢失数据
```

**修复方向**：服务端补全 payload，或客户端条件性覆盖。

## 第三层：数据流追踪

**目标**：从 DB 到 UI 逐跳检查数据是否丢失。

```
DB (approval_metadata) → API response → 前端 state → UI render
```

逐跳检查：

| 跳 | 检查方法 |
|----|---------|
| DB → API | `grep "approval_metadata\|approvalMetadata" routes/execution.ts` — 字段名是 snake_case 还是 camelCase？ |
| API → state | `grep "fetchStatus\|\.then(d =>" component.tsx` — poll 是否读取了该字段？ |
| state → UI | 组件是否 import 了 Dialog？是否实际渲染？是否有 auto-open 的 useEffect？ |

**常见缺失模式**：
- Poll 只读 `status`，漏了 `approvalMetadata`
- 声明了 `approvalOpen` state 但没渲染 `<ApprovalDialog>`
- `pending_approval` 不在 `RUNNING_STATUSES` 里 → 轮询间隔 10s 太慢

## 第四层：代码对比

**目标**：对比功能相似的路径，找出不一致。

典型对比：**resume vs approve**、**正常执行 vs retryFrom**。

```bash
# 并排对比两个方法的实现
grep -n "async resume\|async approve" ExecutionLifecycle.ts
```

**检查清单**：

| 维度 | 对比点 |
|------|--------|
| 阻塞模式 | 是否都是 fire-and-forget？还是一个 await 一个不 await？ |
| DB 更新时机 | 都在 retryFrom 之前？还是一个之前一个之后？ |
| 后台方法 | 是否有 `runXxxInBackground`？是否 await？ |
| SSE 事件 | 两个路径发送的事件和数据是否一致？ |

**典型 bug**：resume 正确地 fire-and-forget，approve 却 `await retryFrom()` 导致 HTTP 阻塞到工作流跑完。

## 第五层：变量替换链

**目标**：追踪 `$nodeId.output` 从 YAML 到 agent prompt 的完整解析路径。

```
YAML 写 $setup.output
  → substitute.ts 正则匹配
    → nodeOutputs[nodeId][key] 查找
      → 谁构建 nodeOutputs？
        → engine.ts executeNode: ✅ 构建
        → agent.ts substituteVars: ❌ 传 undefined
        → loop.ts createExecutor: ❌ 不传 engineContext
```

**三步排查**：

1. **正则是否匹配**：`substitute.ts` 的 `/^([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.]+)$/` 要求三段式 `nodeId.output.key`。YAML 写 `$setup.output`（两段）不匹配。
2. **数据是否存在**：即使正则匹配，`substituteVars` 的 `nodeOutputs` 参数是否为 `undefined`？
3. **engineContext 是否传递**：Loop 内部节点的 AgentExecutor 是否收到 `engineContext`？LoopExecutor 是否收到 `engineNodeResults`？

## 快速参考

| 症状 | 可能原因 | 排查层 |
|------|---------|--------|
| 审批按钮不出现 | SSE 二次覆盖 / Dialog 未渲染 / Poll 漏字段 | 2, 3 |
| 提交后卡"提交中" | approve 阻塞等 retryFrom | 4 |
| 节点无日志 | Loop 内部 logger.log 缺失 | 1 |
| 变量未解析 | substituteVars 传 undefined / 正则不匹配 | 5 |
| 无限循环 | iterations 重置 / override 未清除 | 1, 4 |
| 迭代数不递增 | LoopExecutor 未传 resumeIteration | 1, 4 |

## 常见错误

**SSE 覆盖 bug**：两个 emit 点，后者 payload 缺字段，handler 无条件赋值 → 有效数据被 undefined 覆盖。修复：handler 条件性覆盖 + 服务端补全 payload。

**Fire-and-forget 遗漏**：新写的 handler 方法 `await` 了耗时操作，应改为后台执行 + 立即返回 HTTP 响应。参照已有的 resume 模式。

**Loop 内部节点状态丢失**：LoopExecutor 创建时 `iterations = 0`，resume 后从头开始。修复：传入 `resumeIteration` 参数。

**Override 未清除**：`innerNodeOverrides` 消费后未 `delete`，后续迭代复用第一次的选择。修复：消费后 `this.innerNodeOverrides?.delete(nodeId)`。

**nodeOutputs 未传递**：AgentExecutor 调 `substituteVars` 传 `undefined`，导致 `$nodeId.output` 无法解析。修复：从 `engineContext.nodeResults` 构建 nodeOutputs 并传入。
