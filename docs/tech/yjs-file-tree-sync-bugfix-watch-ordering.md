# 踩坑记录：Yjs 文件树变更不同步——watcher 从未启动

> 诊断日期: 2026-05-17
> 严重程度: **P0 — 核心功能完全失效**
> 影响范围: 文件新增/删除/修改在前端目录树中完全不反映（刷新按钮除外）

---

## 现象

用户在本地目录 `~/.octopus/xzf/workspaces/hello` 增删文件，前端 `http://localhost:3000/workspaces/{id}` 的目录树：
- **删除文件** → 目录树完全不更新，已删文件永远残留
- **新增文件** → 5-10 秒延迟才出现，有时偶尔很快
- **刷新按钮** → 正常工作（调用 `/refresh` API 重建 Y.Map）

---

## 诊断过程

### 第一步：直觉排查（前端 React hooks）

最初怀疑是前端 React hooks 的渲染问题。做了三个修改：

1. **`useYMap` 从 useRef 改为 useState** — 消除 ref 在 useEffect 里赋值、render 里读取的一帧延迟
2. **`useYDoc` 同样从 useRef 改为 useState** — doc 变化时直接触发重渲染，不再依赖 WebSocket 事件
3. **useMemo 依赖加入 `treeVersion`** — Y.Map 引用稳定但内容变了，version 计数器驱动 useMemo 重算

修改后用户反馈：**依旧没解决问题**，删除完全不更新。

反思：前端改了但问题不变 → 根因不在前端，在更上游。

### 第二步：写 Node.js 诊断脚本绕过 React

写了一个独立诊断脚本 `diagnose-yjs-sync.js`，直接用 Node.js + y-websocket + ws 连接 WebSocket 服务器，注册 `observeDeep` 观察者，然后手动创建/删除文件。

关键发现：

```
[diag] TEST 1: Creating file
[diag] After 3s: Y.Map has "diag-test-xxx.txt"? false   ← 新文件没出现！
[diag] After 3s: Total observeDeep fires: 0              ← 观察者从未触发！

[diag] TEST 2: Deleting file
[diag] After 3s: Y.Map has "diag-test-xxx.txt"? false   ← 仍然没有
[diag] After 3s: Total observeDeep fires: 0              ← 仍然零触发
```

**但初始同步是正常的**：Y.Map 从服务器拿到了 13 个文件条目。

这证明：
- WebSocket 连接和 Yjs sync 协议 ✅ 正常
- 初始数据传输 ✅ 正常
- **后续增量更新 ❌ 完全不工作** — 服务端没有广播任何 update

### 第三步：追查服务端 watcher 是否启动

回到 `yjs-ws.ts` 和 `yjs.ts` 的代码，逐步追踪调用顺序：

```
getRoom(roomName)
  ├── const doc = new Y.Doc()
  ├── const conns = new Map()
  ├── initWorkspaceRoom(roomName, doc)    ← 调用！
  │     ├── populateFromDisk(resolvedPath, tree)   ← 正常执行
  │     ├── startWatch(workspaceId, resolvedPath)
  │     │     ├── getYDocForWorkspace(workspaceId)
  │     │     │     ├── docs.get(roomName)   ← room 还没加入 docs Map！
  │     │     │     └── return undefined     ← 查找不到！
  │     │     └── if (!doc) return           ← 直接返回！watcher 未启动！
  │     └── ← watcher 从未启动
  ├── doc.on("update", ...)               ← 注册广播 handler
  ├── room = { doc, awareness, conns }
  └── docs.set(roomName, room)             ← 这时才加入 Map！太晚了！
```

**根因确认**：`docs.set(roomName, room)` 在 `initWorkspaceRoom()` 之后才执行，但 `startWatch()` 通过 `getYDocForWorkspace()` 从 `docs` Map 查找 doc——此时 room 还不在 Map 里，查找返回 undefined，`startWatch` 直接 return，**watcher 从未启动**。

所以：
- `populateFromDisk` 能正常执行是因为它直接操作传入的 `doc` 参数
- `startWatch` 失败是因为它间接查找 doc，而查找时机太早
- 初始数据来自 `populateFromDisk`（一次性加载），watcher 没启动意味着后续变更永远检测不到
- 刷新按钮能工作是因为它调 `/refresh` API → 再次 `populateFromDisk`

### 第四步：修复并验证

**修复**：`startWatch` 改为直接接收 `doc` 参数，不再从 `docs` Map 间接查找。

```typescript
// 修改前
export function startWatch(workspaceId: string, workspacePath: string): void {
  if (watchers.has(workspaceId)) return
  const doc = getYDocForWorkspace(workspaceId)  // ← 从 docs Map 查找，时机问题
  if (!doc) return                               // ← 找不到就退出！
  // ...
}

// 修改后
export function startWatch(workspaceId: string, workspacePath: string, doc: Y.Doc): void {
  if (watchers.has(workspaceId)) return
  // doc 直接传入，不再依赖 docs Map 的查找顺序
  // ...
}
```

同时删除了 `getYDocForWorkspace` 函数（不再需要）。

调用处更新：

```typescript
// yjs-ws.ts — initWorkspaceRoom
startWatch(workspaceId, resolvedPath, doc)  // doc 是 getRoom 传入的参数

// yjs.ts — initWorkspace (API 触发的)
const doc = getOrCreateYDoc(`workspace:${workspaceId}`)
startWatch(workspaceId, resolvedPath, doc)  // doc 已在 docs Map 中，没问题
```

再次运行诊断脚本验证：

```
[diag] TEST 1: Creating file
[diag] === observeDeep #1 fired ===              ← 观察者触发了！
[diag]   key="diag-test-xxx.txt" action=add
[diag]   Y.Map has file? true                     ← 新文件出现！

[diag] TEST 2: Deleting file
[diag] === observeDeep #2 fired ===              ← 删除也触发了！
[diag]   key="diag-test-xxx.txt" action=delete
[diag]   Y.Map has file? false                    ← 文件移除！
```

**增删都即时生效，诊断通过。**

---

## 根因总结

| 层级 | 原始诊断 | 实际根因 |
|------|---------|---------|
| 前端 React | useRef 时序问题导致 Y.Map 不更新 | ❌ 不是主因（但修复仍有价值） |
| Yjs 协议 | 观察者不触发 | ❌ 协议本身没问题 |
| **服务端 watcher** | **`startWatch` 在 `docs.set` 前调用，间接查找失败** | ✅ **这就是根因** |

核心教训：**间接查找依赖初始化顺序，而直接传参不依赖**。当一个函数需要获取"刚刚创建但还没注册"的资源时，间接查找一定失败。

---

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `packages/server/src/services/yjs.ts` | 删除 `getYDocForWorkspace`；`startWatch` 增加 `doc` 参数 |
| `packages/server/src/routes/yjs-ws.ts` | `initWorkspaceRoom` 传 `doc` 给 `startWatch` |
| `packages/web-app/lib/yjs-provider.ts` | `useYDoc`/`useYMap` 从 useRef 改为 useState（消除渲染时序问题） |
| `packages/web-app/components/workspace/sidebar-file-tree.tsx` | useMemo 加入 treeVersion 依赖；移除 debug console.log |

---

## 诊断方法论总结

1. **怀疑前端 → 改前端 → 不变 → 推翻假设**：不要在不确定根因位置时深度修改
2. **写独立脚本绕过前端**：Node.js 直连 WebSocket 服务器，排除 React 变量
3. **脚本结果比理论分析更可靠**：observeDeep 触发 0 次 = 服务端根本没广播，不是客户端没渲染
4. **追踪调用顺序**：回到服务端代码逐步模拟 `getRoom` 的执行流程，发现 `docs.set` 在 `initWorkspaceRoom` 之后
5. **简化依赖链**：从间接查找改为直接传参，消除初始化顺序依赖

---

## 附：前端 hooks 修复细节

虽然根因在服务端，前端的 `useRef` → `useState` 改进仍有实际价值：

### 问题

`useYDoc` 和 `useYMap` 用 `useRef` 存储 doc/map，但 ref 在 `useEffect`（渲染后）赋值，在 return（渲染中）读取。`useYDoc` 的 `docRef.current = doc` 没有触发重渲染——只有 WebSocket 事件（connected/synced）才触发。组件可能长时间持有 `doc=null`。

### 修复

```typescript
// useYDoc: 从 docRef 改为 useState
const [doc, setDoc] = useState<Y.Doc | null>(null)
useEffect(() => {
  const doc = new Y.Doc()
  setDoc(doc)  // 直接触发重渲染
  // cleanup: setDoc(null)
}, [workspaceId])

// useYMap: 从 mapRef + version 分离改为统一 state
const [state, setState] = useState<{ map: Y.Map | null; version: number }>({ map: null, version: 0 })
useEffect(() => {
  if (!doc) { setState({ map: null, version: 0 }); return }
  const m = doc.getMap(name)
  setState(prev => ({ map: m, version: prev.version + 1 }))
  const observer = () => setState(prev => ({ map: prev.map, version: prev.version + 1 }))
  m.observeDeep(observer)
  return () => m.unobserveDeep(observer)
}, [doc, name])
```

核心改进：`map` 和 `version` 在同一个 state 对象中，始终一致。observeDeep 触发时 `version` 递增，useMemo 的 `treeVersion` 依赖立即变化，重算目录树。