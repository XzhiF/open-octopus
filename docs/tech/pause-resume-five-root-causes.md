# 踩坑记录：工作流暂停/继续功能——五层根因与七轮修复

> 诊断日期: 2026-06-02 ~ 2026-06-03
> 严重程度: **P0 — 暂停功能完全失效**
> 影响范围: 用户点击暂停后节点继续运行、继续后节点不重新执行、UI 状态卡死

---

## 现象

用户在工作流执行过程中点击「暂停」按钮，期望：
1. 当前运行的节点（如 bash 脚本）立即停止
2. 后续节点不再执行
3. 按钮状态切换为「继续」

实际表现：
- 点击暂停后，**bash 节点继续运行**，完全不停
- 即使节点最终停了，后续节点还是继续执行
- 偶尔节点停了，但状态不一致

---

## 诊断过程

### 第一轮：写 5 个独立测试，逐层隔离问题

按照「不急着改代码，先写最小验证」的策略，在 `tests/pause-debug/` 下创建了 5 个独立测试脚本：

#### Test 1: taskkill 能否杀死进程树

验证 Windows 上 `taskkill /PID {pid} /T /F` 能否杀死 bash 子进程。

```
结果: PASS ✅
结论: bash executor 的进程杀死机制没问题
```

#### Test 2: 模拟完整暂停流程

模拟 engine → executor → abort signal → 进程死亡的完整链路。

```
结果: PASS ✅ (在隔离环境中)
结论: 理论上暂停流程是通的
```

#### Test 3: AbortController 复用问题

模拟 resume 场景：pause 时 abort，resume 时复用同一个 AbortController。

```javascript
const ac = new AbortController()
// pause
ac.abort()
console.log(ac.signal.aborted)  // true — 不可逆！

// resume — 复用同一个 controller
console.log(ac.signal.aborted)  // 仍然 true — 永远 aborted！
```

```
结果: FAIL ❌
根因: AbortController.abort() 是不可逆的
     resume 复用已 abort 的 controller → signal 永远 aborted → 后续节点立即被取消
```

#### Test 4: 新建 AbortController 修复验证

```javascript
const ac1 = new AbortController()
ac1.abort()  // pause

const ac2 = new AbortController()  // resume — 新建！
console.log(ac2.signal.aborted)  // false ✅
```

```
结果: PASS ✅
结论: resume 必须新建 AbortController
```

#### Test 5: Signal 是否正确传递到 executor

检查 engine 代码，发现 `executeSingleNode()` 接受 `signal` 参数，但 `createExecutor()` 忽略了它，使用 `this.signal`（旧的、已 abort 的 signal）。

```typescript
// 修复前
private createExecutor(node: NodeDef, pool?: VarPool) {
  return new BashExecutor(node, pool, this.signal, ...)  // 始终用 this.signal
}

// 修复后
private createExecutor(node: NodeDef, pool?: VarPool, signal?: AbortSignal) {
  const s = signal ?? this.signal
  return new BashExecutor(node, pool, s, ...)  // 优先用传入的 signal
}
```

```
结果: FAIL ❌ → 修复后 PASS ✅
结论: createExecutor 必须接受并优先使用传入的 signal
```

### 修复根因 1 & 2 → 用户反馈「依旧不工作」

应用了以上两个修复后，构建通过、650 个测试全绿。但用户测试后反馈：**「这个现象依旧」**。

### 第二轮：分析用户提供的日志，发现真正根因

用户提供了服务端日志，关键信息：

```
[EnginePool] create: executionId=xxx, pool.size=1     ← start 时 pool 有 1 个引擎
[ExecutionService] pause: enginePool.get="false"      ← pause 时找不到引擎！
[EnginePool] remove: 没有日志                          ← 引擎从未被 remove
```

`pool.size=1` 说明 start 时引擎确实被存入了 pool。`pause` 时 `enginePool.get=false` 说明查不到。引擎没有被 remove。那引擎去哪了？

**答案：不同的 pool 实例**。

### 追踪 `getService()` → 发现每次请求都创建新 ExecutionService

```typescript
// routes/execution.ts — 修复前
function getService(workspaceId: string) {
  const ws = new WorkspaceService(getDb()).getById(workspaceId)
  const service = new ExecutionService(...)  // ← 每次请求都 new 一个！
  return { service, wsPath: resolvedPath }
}
```

Hono 路由中，每个 HTTP 请求都会调用 `getService()`，而 `getService()` 每次都 `new ExecutionService()`。每个 ExecutionService 有自己独立的 `enginePool`。

所以：
- `POST /start` → `getService()` → `new ExecutionService()` (#1) → `enginePool.create()` 存入 #1 的 pool
- `POST /pause` → `getService()` → `new ExecutionService()` (#2) → `enginePool.get()` 从 #2 的 pool 查 → **空 pool，找不到！**

**这就是真正的根因：start 和 pause 用的是两个完全不同的 EnginePool。**

### 修复根因 3：serviceCache

```typescript
// routes/execution.ts — 修复后
const serviceCache = new Map<string, { service: ExecutionService; wsPath: string }>()

function getService(workspaceId: string) {
  const cached = serviceCache.get(workspaceId)
  if (cached) return cached  // ← 命中缓存，同一个实例

  const service = new ExecutionService(...)
  const result = { service, wsPath: resolvedPath }
  serviceCache.set(workspaceId, result)
  return result
}
```

### 第三轮：暂停能停了，但继续后节点不重新执行

暂停终于能工作了。但点击「继续」后，暂停的节点被跳过了，没有重新执行。

**根因 4：reconstructEngine 加载了旧结果**

`resume()` 调用 `reconstructEngine()` 从 DB 恢复引擎状态。DB 中暂停节点的 status 是 `'paused'`。`reconstructEngine` 把它加载到 `this.nodeResults[nodeId]`。

然后 `retryFrom()` 调用 `executeNodes(remainingNodes)` → `executeNodesSequential()`：

```typescript
// 跳过已有终态结果的节点
const existingResult = this.nodeResults[node.id]
if (existingResult && ["completed", "failed", "skipped", "rejected",
    "cancelled", "paused", "pending_approval"].includes(existingResult.status)) {
  continue  // ← "paused" 被视为终态，直接跳过！
}
```

**修复**：在 `retryFrom()` 中清除暂停节点的旧结果：

```typescript
async retryFrom(nodeId, opts) {
  this.pausedAt = undefined       // 清除暂停状态
  delete this.nodeResults[nodeId]  // 删除旧结果，确保重新执行
  // ...
}
```

### 第四轮：继续按钮卡在「提交中...」

暂停→继续的后台流程能正常工作了，但前端的干预对话框卡在「提交中...」，永远不关闭。

**根因 5：resume() 是同步等待**

```typescript
// services/execution.ts — 修复前
async resume(executionId, intervention) {
  // ...
  const result = await inst.engine.retryFrom(...)  // ← 等整个工作流跑完！
  // 工作流可能跑 5-10 分钟
  return { success: true }
}
```

`resume()` `await` 了 `engine.retryFrom()`，而 `retryFrom()` 要跑完整个工作流才返回。HTTP 请求一直挂着，前端 `fetch()` 的 Promise 永远不 resolve → 按钮卡在「提交中...」。

**修复**：resume API 改为 fire-and-forget：

```typescript
async resume(executionId, intervention) {
  // ... 设置状态 ...
  this.runResumeInBackground(executionId, nodeId, signal, intervention, workflowRef)
  return { success: true }  // ← 立即返回！
}

private async runResumeInBackground(...) {
  // 后台执行，不阻塞 HTTP 响应
}
```

### 第五轮：干预 prompt 与后续节点竞态

resume API 改成 fire-and-forget 后，intervetion 也变成了 fire-and-forget（后台执行不等待）。engine 立即继续跑后续节点。

**问题**：intervention 和后续节点可能同时使用同一个 Claude session，导致竞态冲突。intervention 的 AI 回复对后续节点不可见。

**修复**：intervention 改回阻塞模式（`await interventionRunner.run()`）。因为 resume API 已经是 fire-and-forget，整个 engine 执行都在后台，不会阻塞前端 HTTP 响应。

```
修复前: resume API 阻塞 → intervention 必须 fire-and-forget → 竞态
修复后: resume API fire-and-forget → intervention 可以阻塞 → 无竞态
```

### 第六轮：「暂停中...」一直不消失

暂停能停了，继续也正常了，但暂停按钮的「暂停中...」loading 状态一直不消失，需要刷新页面。

**根因 6：abortAndWait 盲等 60 秒**

```typescript
// 修复前
private async abortAndWait(abortController, timeoutMs = 60000) {
  abortController.abort()
  await new Promise(resolve => setTimeout(resolve, timeoutMs))  // 死等 60 秒！
}
```

HTTP 响应要等 60 秒才返回，前端 `finally` 要等 HTTP 响应才能清除「暂停中...」状态。

**修复**：改为轮询 DB 状态（类似 Java `Future.get(timeout)`）：

```typescript
private async abortAndWait(abortController, timeoutMs = 60000) {
  abortController.abort()

  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 200))  // 每 200ms 检查
    const running = this.db.prepare(
      "SELECT COUNT(*) as count FROM executions WHERE workspace_id = ? AND status = 'running'"
    ).get(this.workspaceDbId) as { count: number }
    if (running.count === 0) return  // 引擎已停止，立即返回
  }
}
```

同时添加 `useEffect` 监听 `treeNodes` 变化，当节点状态变为非 running 时自动清除 pausing 状态。

### 第七轮：React 初始化顺序错误

添加 `useEffect` 后，页面报错 `Cannot access 'treeNodes' before initialization`。

**根因 7：useEffect 引用了尚未初始化的变量**

```typescript
// workflow-flow-panel.tsx — 修复前
const [pausingNodeIds, setPausingNodeIds] = useState(new Set())

useEffect(() => {
  // 用了 treeNodes，但 treeNodes 在下面才定义！
  for (const id of pausingNodeIds) {
    const node = treeNodes.find(n => n.id === id)  // ❌ ReferenceError
  }
}, [pausingNodeIds, treeNodes])

const { treeNodes, ... } = useExecutionTree(...)  // ← treeNodes 在这里才初始化
```

**修复**：将 `useEffect` 移到 `useExecutionTree` 调用之后。

---

## 根因全景

| # | 层级 | 根因 | 表现 |
|---|------|------|------|
| 1 | Engine | AbortController.abort() 不可逆，resume 复用已 abort 的 controller | 继续后所有节点立即被取消 |
| 2 | Engine | createExecutor 忽略传入的 signal，使用 this.signal（旧的） | executor 拿到错误的 signal |
| 3 | **Routes** | **getService() 每次请求创建新 ExecutionService → 不同的 EnginePool** | **pause 请求找不到 start 创建的引擎（真正根因）** |
| 4 | Engine | reconstructEngine 加载 paused 节点到 nodeResults，executeNodesSequential 视为终态跳过 | 继续后暂停节点被跳过 |
| 5 | Server | resume() await 整个工作流，HTTP 响应挂起 | 前端按钮卡在「提交中...」 |
| 6 | Server | abortAndWait 盲等 60 秒 | 「暂停中...」状态持续 60 秒 |
| 7 | Frontend | useEffect 引用未初始化的 treeNodes | 页面白屏 ReferenceError |

核心教训：**根因 3 是最关键的**。前两个修复（AbortController、signal 传递）在理论上是必要的，但不是用户实际遇到的问题。真正导致「暂停完全无效」的是 ExecutionService 实例不共享。如果一开始就检查路由层，可以节省大量排查时间。

---

## 修复架构总览

```
用户点击暂停
  ↓
前端: pausingNodeIds.add(id) → 按钮立即变为 "暂停中..." + spinner
  ↓
HTTP POST /pause
  ↓
后端 getService(workspaceId) → serviceCache 命中 → 同一个 ExecutionService ✅
  ↓
pause() 方法:
  1. DB: node_executions status → 'paused'
  2. DB: executions status → 'paused'
  3. engine.pauseAtNode(nodeId) → 设置 pausedAt 标记
  4. abortAndWait():
     - abort() 发送信号
     - 轮询 DB，每 200ms 检查一次
     - 引擎停止后立即返回（通常 1-3 秒）✅
  5. SSE emit: execution_paused
  6. return { success: true }
  ↓
HTTP 响应返回（1-3 秒）
  ↓
前端 finally: pausingNodeIds.delete(id) → "暂停中..." 清除 ✅
  ↓
SSE 事件到达 → 前端刷新树 → executionStatus = 'paused' → 显示"继续"按钮
  ↓
用户点击继续 → 弹出干预对话框（输入可选）✅
  ↓
HTTP POST /resume → 立即返回（fire-and-forget）✅
  ↓
后台:
  1. 新建 AbortController ✅
  2. engine.updateSignal(newSignal) ✅
  3. retryFrom():
     - 清除 pausedAt ✅
     - delete nodeResults[nodeId]（确保重新执行）✅
     - intervention 阻塞等待完成（同一 session 继续对话）✅
     - executeNodes(remainingNodes) → 从暂停节点继续
```

---

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `packages/server/src/routes/execution.ts` | serviceCache 缓存 ExecutionService 实例 |
| `packages/server/src/services/execution.ts` | abortAndWait 改轮询；resume 改 fire-and-forget；新建 AbortController |
| `packages/engine/src/engine.ts` | createExecutor 接受 signal；retryFrom 清除 pausedAt/nodeResults；intervention 改阻塞；日志持久化 |
| `packages/web-app/components/workspace/workflow-flow-panel.tsx` | pausingNodeIds 状态管理；useEffect 自动清除 |
| `packages/web-app/components/workspace/workflow-nodes/execution-button-bar.tsx` | 暂停按钮 loading 状态；暂停/审批状态显示终止按钮 |
| `packages/web-app/components/workspace/workflow-nodes/execution-node-context.tsx` | isPausing 回调 |
| `packages/web-app/components/workspace/workflow-nodes/execution-node.tsx` | 传递 pausing 状态 |
| `packages/web-app/hooks/use-execution-tree.ts` | TreeCallbackOverrides 添加 isPausing |
| `packages/web-app/components/workspace/intervention-dialog.tsx` | 输入框改为可选 |

---

## 诊断方法论总结

1. **写独立测试隔离问题**：5 个测试脚本逐层排除，确认 taskkill、AbortController、signal 传递各自是否正确
2. **日志比推理更可靠**：用户提供的 `[EnginePool] create pool.size=1` + `pause get=false` 直接揭示了真正根因
3. **分层排查**：从底层（进程管理）→ 中间层（引擎信号传递）→ 上层（路由实例管理），逐层排除
4. **不要假设修了就好**：第一轮修了两个根因，测试全绿，但用户反馈依旧不工作 → 说明遗漏了更根本的问题
5. **fire-and-forget vs 阻塞的平衡**：resume API 需要 fire-and-forget（不阻塞前端），intervention 需要阻塞（不竞态 session），两者不矛盾

---

## 附：5 个根因验证测试

位于 `tests/pause-debug/`：

| 文件 | 验证内容 | 结果 |
|------|---------|------|
| `01-test-taskkill.mjs` | Windows taskkill 能否杀死进程树 | PASS ✅ |
| `02-test-pause-flow.mjs` | 完整暂停流程（隔离环境） | PASS ✅ |
| `03-test-abort-controller-reuse.mjs` | AbortController 复用问题 | FAIL → 发现根因 1 |
| `04-test-resume-fix.mjs` | 新建 AbortController 修复 | PASS ✅ |
| `05-test-signal-mismatch.mjs` | signal 未传递到 executor | FAIL → 发现根因 2 |

详细分析报告见 `tests/pause-debug/README.md`。
