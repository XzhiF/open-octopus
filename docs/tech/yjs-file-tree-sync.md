# Yjs 文件树实时同步系统

> 基于 CRDT (Conflict-free Replicated Data Types) 的实时协同文件树同步方案

## 目录

- [核心概念](#核心概念)
- [架构设计](#架构设计)
- [数据模型](#数据模型)
- [详细实现](#详细实现)
- [CRUD 操作流程](#crud-操作流程)
- [问题与修复](#问题与修复)
- [性能优化](#性能优化)

---

## 核心概念

### 为什么用 Yjs 而不是 REST API？

传统 REST 方案每次文件变更需要**全量**传输目录树。即使只改一个文件，也要重新获取整个目录结构。Yjs CRDT 只传输**增量更新（delta）**，客户端和服务端各自维护一份数据副本，自动解决并发冲突。

| 对比维度 | REST API | Yjs CRDT |
|----------|----------|----------|
| 传输量 | 全量目录树 | 增量 delta（仅变更部分） |
| 实时性 | 需轮询 | WebSocket 推送 |
| 并发处理 | 需自行实现 | CRDT 自动合并 |
| 离线支持 | 不支持 | 支持（reconnect 自动同步） |

### Yjs 基本概念

```
Y.Doc          — 文档根容器，所有共享数据存在此之下
Y.Map          — 键值映射，类似 JavaScript Map，嵌套结构的基础
Y.Text         — 文本类型，CRDT 文本编辑，支持并发插入/删除
Awareness      — 感知协议，传递客户端在线状态、光标位置等元信息
```

### 同步协议

```
messageSync (0)        — 文档内容同步（state vector + delta update）
messageAwareness (1)   — 客户端感知信息同步
messageAuth (2)        — 认证
messageQueryAwareness (3) — 查询感知状态（仅 BroadcastChannel，不经过 WS）
```

---

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器 (Next.js)                      │
│                                                             │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐ │
│  │ SidebarFile  │◄───│  useYMap("file  │◄───│ Y.Doc     │ │
│  │ Tree         │    │  Tree")          │    │           │ │
│  │ (React渲染)  │    │  (observeDeep)   │    │ ▲ Y.Map   │ │
│  └──────────────┘    └──────────────────┘    │ │ 嵌套结构 │ │
│                                              │ │ Y.Text   │ │
│  ┌──────────────┐                            │ └─────────┘ │
│  │ TextEditor   │──► MonacoBinding ──────────► Y.Text     │ │
│  │ Tab          │    (y-monaco)              │             │ │
│  └──────────────┘                            └─────┬───────┘ │
│                                                    │         │
│  ┌──────────────────────────────────────┐           │         │
│  │ WebsocketProvider (y-websocket v3)   │══════════╝         │
│  │ ws://localhost:3001/workspace:{id}   │                     │
│  └──────────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
                            │ WebSocket
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     服务端 (Hono + Node.js)                    │
│                                                              │
│  ┌─────────────────────────────────────────────┐             │
│  │ yjs-ws.ts  (自定义 WS 服务器)                │             │
│  │                                             │             │
│  │  getRoom("workspace:{id}")                  │             │
│  │    ├── Y.Doc                                │             │
│  │    ├── Awareness                            │             │
│  │    ├── conns: Map<WebSocket, Set<number>>   │             │
│  │    ├── initWorkspaceRoom() ──► DB查询路径   │             │
│  │    ├── doc.on("update") ──► 广播到客户端    │             │
│  │    └── awarenessChangeHandler               │             │
│  └─────────────────────────────────────────────┘             │
│                            │                                  │
│  ┌─────────────────────────┴──────────────┐                  │
│  │ services/yjs.ts                         │                  │
│  │                                         │                  │
│  │  populateFromDisk() ──► 递归读取文件系统 │                  │
│  │  startWatch()        ──► chokidar 监听   │                  │
│  │    handleAdd()       ──► 增量添加 Y.Map  │                  │
│  │    handleChange()    ──► 增量更新 Y.Text │                  │
│  │    handleRemove()    ──► 增量删除 Y.Map  │                  │
│  │  closeWorkspace()    ──► 清理监听器      │                  │
│  └─────────────────────────────────────────┘                  │
│                            │                                  │
│  ┌─────────────────────────┴──────────────┐                  │
│  │ routes/file-routes.ts                   │                  │
│  │                                         │                  │
│  │  POST   /api/.../files  ──► 创建文件    │                  │
│  │  PUT    /api/.../files  ──► 保存文件    │                  │
│  │  DELETE /api/.../files  ──► 删除文件    │                  │
│  │  POST   /api/.../files/refresh ──► 重建 │                  │
│  └──────────────┬──────────────────────────┘                  │
│                 │                                             │
│  ┌──────────────┴──────────────────────────────┐             │
│  │ services/file-service.ts                     │             │
│  │                                              │             │
│  │  createFile() / createDirectory()            │             │
│  │  saveFile() / deleteFile() / readFile()      │             │
│  │  (带路径穿越防护的磁盘 I/O)                   │             │
│  └──────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

### 数据流方向

```
正向（磁盘 → 浏览器）：
  文件系统 ──chokidar──► Y.Map ──doc.on("update")──► WS广播 ──► Y.Doc ──observeDeep──► React

反向（浏览器 → 磁盘）：
  ┌─ 乐观路径（即时反馈）──────────────────────────┐
  │  addToYTree/deleteFromYTree → Y.Map → WS → 服务端 │
  └────────────────────────────────────────────────┘
  ┌─ 持久化路径（可靠性保证）───────────────────────┐
  │  REST API → FileService → fs.write/unlink → chokidar │
  │  → handleAdd/handleRemove → Y.Map → WS → 所有客户端   │
  └────────────────────────────────────────────────────┘
```

---

## 数据模型

### Y.Map 文件树结构

```
Y.Doc "workspace:{id}"
  └── fileTree: Y.Map
        ├── "src": Y.Map                     ← 目录（无 "content" 键）
        │     ├── "index.ts": Y.Map           ← 文件（有 "content" 键）
        │     │     ├── content: Y.Text       ← 文件内容
        │     │     ├── size: number          ← 文件大小（字节）
        │     │     └── extension: string     ← 文件扩展名
        │     └── "utils": Y.Map              ← 子目录
        │           └── ...
        ├── "README.md": Y.Map
        │     ├── content: Y.Text
        │     ├── size: 1234
        │     └── extension: "md"
        └── "package.json": Y.Map
              ├── content: Y.Text
              ├── size: 567
              └── extension: "json"
```

### 节点类型判断

```typescript
// 判断一个 Y.Map 条目是目录还是文件
// 有 "content" 键 → 文件节点
// 无 "content" 键 → 目录节点
const isFile = yMapEntry.has("content")
```

### `populateFromDisk` 递归填充

```typescript
export function populateFromDisk(dirPath: string, tree: Y.Map<unknown>): void {
  tree.clear()  // 清空当前层
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const dir of dirs) {
    const childMap = new Y.Map()
    tree.set(dir.name, childMap)
    populateFromDisk(path.join(dirPath, dir.name), childMap)  // 递归
  }

  for (const file of files) {
    const ytext = new Y.Text()
    ytext.insert(0, fs.readFileSync(fullPath, "utf-8"))
    const meta = new Y.Map()
    meta.set("content", ytext)
    meta.set("size", stat.size)
    meta.set("extension", ext)
    tree.set(file.name, meta)
  }
}
```

---

## 详细实现

### 1. 服务端 WebSocket 服务器 (`yjs-ws.ts`)

完全参照 `y-websocket` 官方 v2 服务端 (`bin/utils.cjs`) 实现，兼容 `y-websocket@3` 客户端协议。

#### 房间生命周期

```typescript
function getRoom(roomName: string): Room {
  let room = docs.get(roomName)
  if (!room) {
    // 创建新房间
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)  // 服务端自身状态设为 null
    const conns = new Map<WebSocket, Set<number>>()

    // ★ 关键：初始化在 handler 注册之前
    initWorkspaceRoom(roomName, doc)

    // 文档更新广播
    doc.on("update", (update, origin) => {
      for (const [conn] of conns) {
        if (conn !== origin && conn.readyState === WebSocket.OPEN) {
          conn.send(encodedMessage)
        }
      }
    })

    // 感知信息跟踪（正确的 controlledIds 管理）
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      if (conn !== null) {
        const controlled = conns.get(conn)
        for (const id of added) controlled.add(id)
        for (const id of removed) controlled.delete(id)
      }
      // 广播 awareness 更新
    }
    awareness.on("update", awarenessChangeHandler)

    room = { doc, awareness, conns }
    docs.set(roomName, room)
  }
  return room
}
```

#### 消息处理

```typescript
ws.on("message", (data) => {
  switch (messageType) {
    case 0: // messageSync — 文档同步
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
      break
    case 1: // messageAwareness — 感知信息
      awarenessProtocol.applyAwarenessUpdate(awareness, data, ws)
      break
    case 3: // messageQueryAwareness — 查询感知
      // 回复所有已知的感知状态
      break
  }
})
```

#### 连接管理

```typescript
// 新连接
room.conns.set(ws, new Set())
// 发送 sync step 1
syncProtocol.writeSyncStep1(encoder, doc)
ws.send(msg)

// 连接关闭
const controlledIds = room.conns.get(ws)
room.conns.delete(ws)
awarenessProtocol.removeAwarenessStates(awareness, controlledIds, null)
if (room.conns.size === 0) {
  closeWorkspace(workspaceId)  // 清理 chokidar 监听器
  doc.destroy()
  docs.delete(roomName)
}
```

### 2. 文件监听 (`services/yjs.ts`)

使用 `chokidar` 增量监听文件变更，直接操作 Y.Map 而非全量 clear+rebuild。

#### 增量操作（关键优化）

```
❌ 旧方案: repopulate → tree.clear() + populateFromDisk() → UI 闪烁
✅ 新方案: handleAdd/handleChange/handleRemove → 精确操作单个节点 → 无闪烁
```

```typescript
// 创建文件 — 增量添加
watcher.on("add", handleAdd)
const handleAdd = debounce((filePath) => {
  const rel = path.relative(workspacePath, filePath)
  // 导航到父目录 Y.Map
  const parentMap = createDirPath(tree, segs.slice(0, -1))
  if (parentMap.has(baseName)) return  // 已存在，跳过

  const ytext = new Y.Text()
  ytext.insert(0, fs.readFileSync(filePath, "utf-8"))
  const meta = new Y.Map()
  meta.set("content", ytext)
  meta.set("size", stat.size)
  meta.set("extension", ext)
  parentMap.set(baseName, meta)
}, 50)

// 修改文件 — 更新 Y.Text 内容
watcher.on("change", handleChange)
const handleChange = debounce((filePath) => {
  const ytext = node.get("content") as Y.Text
  ytext.delete(0, ytext.length)
  ytext.insert(0, fs.readFileSync(filePath, "utf-8"))
}, 50)

// 删除文件 — 移除 Y.Map 条目
watcher.on("unlink", handleRemove)
const handleRemove = debounce((filePath) => {
  parentMap.delete(baseName)
}, 50)
```

#### ignored 排除规则

```javascript
ignored: /(^|[\/\\])(\.(?!claude)|node_modules|target|dist|build|\.next|
  \.nuxt|\.output|\.cache|coverage|__pycache__|vendor|bower_components)|
  \.(class|jar|war|ear|o|so|dll|exe|pyc|rbc|beam)$/
```

排除常见的构建产物目录和编译输出文件，避免项目编译时产生大量无用 chokidar 事件。

### 3. React Hooks (`yjs-provider.ts`)

#### useYDoc

```typescript
export function useYDoc(workspaceId: string): UseYDocResult {
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    docRef.current = doc
    const provider = new WebsocketProvider(
      WS_URL, `workspace:${workspaceId}`, doc
    )
    provider.on("status", (e) => setConnected(e.status === "connected"))
    provider.on("sync", setSynced)
    return () => { provider.disconnect(); doc.destroy() }
  }, [workspaceId])

  return { doc: docRef.current, connected, synced }
}
```

#### useYMap (关键：强制 React re-render)

```typescript
export function useYMap(doc: Y.Doc | null, name: string): Y.Map<unknown> | null {
  const mapRef = useRef<Y.Map<unknown> | null>(null)
  const [, rerender] = useState(0)

  useEffect(() => {
    const m = doc.getMap(name)
    mapRef.current = m

    // ★ Y.Map 是 mutable 对象，React 无法检测引用变化
    // 用计数器强制 re-render
    const observer = () => rerender((v) => v + 1)
    m.observeDeep(observer)  // observeDeep 监听嵌套子 Map 变化
    return () => m.unobserveDeep(observer)
  }, [doc, name])

  return mapRef.current  // 始终返回同一个 Y.Map 引用
}
```

### 4. Monaco Editor 集成 (`text-editor-tab.tsx`)

```typescript
// y-monaco 的 MonacoBinding 将 Monaco Editor 直接绑定到 Y.Text
const { MonacoBinding } = await import("y-monaco")
const ytext = getYText(doc, filePath)
if (ytext) {
  bindingRef.current = new MonacoBinding(ytext, model, new Set(), undefined)

  // Y.Text 变化 → 同步到 React state（用于脏检测）
  ytext.observe(() => onContentChange?.(filePath, ytext.toString()))

  // Ctrl+S → 保存到磁盘
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    onSave?.(filePath, ytext.toString())
  })
}
```

### 5. 文件 CRUD API (`file-routes.ts` + `file-service.ts`)

```
POST   /api/workspaces/:id/files  { path, type, content? }  → 创建文件/目录
PUT    /api/workspaces/:id/files  { path, content }          → 保存文件内容
DELETE /api/workspaces/:id/files  { path }                   → 删除文件/目录
POST   /api/workspaces/:id/files/refresh                     → 从磁盘重建 Y.Map
```

`FileService` 使用 `path.resolve` + 前缀校验实现路径穿越防护。

### 6. 刷新机制

```
浏览器点击刷新按钮 → POST /refresh → Y.transact(doc) {
    populateFromDisk(resolvedPath, tree)
} → 一次事务全量重建 Y.Map → 广播到所有客户端
```

使用 `Y.transact` 将 clear + rebuild 合并为单个原子操作，客户端接收到后一次性更新，无闪烁。

---

## CRUD 操作流程

### 创建文件

```
浏览器                                  服务端
──────                                 ──────
用户输入文件名
  │
  ├─ handleCreateEntry()
  │    │
  │    ├─ createFileEntry API ────►  FileService.createFile()
  │    │                                 │ fs.writeFileSync()
  │    │                                 ▼
  │    │                            chokidar "add" 事件
  │    │                                 │ handleAdd (debounce 50ms)
  │    │                                 │ Y.Map.set(baseName, meta)
  │    │                                 ▼
  │    │                            doc.on("update") → WS 广播
  │    │                                 │
  │    ├─ addToYTree(yDoc, path)    ◄────┘ (后续 chokidar 确认)
  │    │    └─ Y.Map.set(meta) ──────────► (另一条 Yjs 广播路径)
  │    │
  │    ├─ 打开新 EditorTab
  │    └─ toast "已创建文件"
  │
  ▼
  SidebarFileTree 即时更新 (乐观) + chokidar 后续确认

总延迟: API (~10ms) + Y.Map 乐观写入 (~0ms) + React渲染 (~16ms) = ~30ms
chokidar 确认延迟: ~50ms (debounce) + WS广播 (~1ms) = ~51ms (仅用于服务端一致性)
```

### 删除文件

```
浏览器确认删除
  │
  ├─ deleteFileEntry API ────────►  FileService.deleteFile()
  │                                      │ fs.unlinkSync()
  │                                      ▼
  │                                 chokidar "unlink" 事件
  │                                      │ handleRemove (debounce 50ms)
  │                                      │ Y.Map.delete(baseName)
  │                                      ▼
  │                                 doc.on("update") → WS 广播
  │
  ├─ deleteFromYTree(yDoc, path)
  │    └─ Y.Map.delete(baseName) ──────► (另一条 Yjs 广播路径)
  │
  └─ 关闭相关 Tab + toast

Y.Map 删除立即生效 (乐观路径)
chokidar 删除为幂等操作（条目已不存在，no-op）
```

### 编辑保存

```
用户在 Monaco Editor 输入
  │
  ├─ MonacoBinding → Y.Text 变化
  │    │
  │    ├─ WS 广播 → 服务端 Y.Doc 同步更新
  │    └─ Y.Text observer → onContentChange → React state → 脏检测显示
  │
  ├─ Ctrl+S / 保存按钮
  │    │
  │    ├─ saveFileEntry API ────► FileService.saveFile()
  │    │                               │ fs.writeFileSync()
  │    │                               ▼
  │    │                          chokidar "change" 事件
  │    │                               │ handleChange (debounce 50ms)
  │    │                               │ Y.Text 内容更新（幂等）
  │    │                               ▼
  │    │                          doc.on("update") → WS 广播（确认）
  │    │
  │    └─ setSavedContents → 清除脏状态
  │
  └─ toast "文件已保存"
```

---

## 问题与修复

### 1. 目录树不显示 (React `useYMap` 不触发 re-render)

**原因**：`useYMap` 通过 `setMap(m)` 返回同一个 `Y.Map` 引用。React 的 `Object.is(m, m)` 判定引用相同 → 跳过 re-render → `useMemo` 缓存失效 → 目录树始终为空。

`Y.Map` 是 mutable 对象，内容变化但引用不变，React 无法感知。

**修复**：使用独立计数器 `rerender(v => v + 1)` 强制触发 re-render，并用 `observeDeep` 替换 `observe` 来监听嵌套 Map 的变化。

```typescript
const [, rerender] = useState(0)
const observer = () => rerender((v) => v + 1)
m.observeDeep(observer)  // observeDeep 监听嵌套子 Map 变化
```

**涉及文件**：`packages/web-app/lib/yjs-provider.ts`

---

### 2. `JSON.parse` awareness 协议错误

**原因**：

1. 服务端 `awareness.setLocalState(null)` 未显式调用。JavaScript 默认 `undefined` 状态 → `JSON.stringify(undefined)` 返回 `undefined`（不是字符串）→ `writeVarString(undefined)` 写入空字符串 → 客户端 `JSON.parse("")` 抛出 "Unexpected end of JSON input"
2. `conns` 结构为 `Map<WebSocket, number>`，无法正确跟踪每个连接对应的多个 awareness client ID
3. `initWorkspaceRoom` 在 handler 注册之后执行 → populate 产生的 doc change 被广播给未完成 sync 的客户端

**修复**：完全对齐官方 `y-websocket` v2 协议实现：
- `awareness.setLocalState(null)` 显式调用
- `conns` 改为 `Map<WebSocket, Set<number>>` 跟踪受控 ID
- 使用 `awarenessChangeHandler` 管理 controlledIds
- `initWorkspaceRoom` 移到 handler 注册之前
- 新增 `messageQueryAwareness` (type=3) 处理

**涉及文件**：`packages/server/src/routes/yjs-ws.ts`

---

### 3. 新建/删除/保存完全不生效

**原因**：`index.ts` 从 `createAdaptorServer` 换为原始 `http.createServer` 后，HTTP 请求体被丢弃：

```typescript
// ❌ body 永远为 undefined
const request = new Request(url, {
  method: req.method,
  body: undefined,  // 致命缺陷
})
```

所有 POST/PUT/DELETE 的 JSON body 无法传到 Hono → `c.req.json()` 解析空 → API 静默失败。

**修复**：从 Node.js `req` 流中读取 body chunks 并转发：

```typescript
const chunks: Buffer[] = []
for await (const chunk of req) {
  chunks.push(Buffer.from(chunk))
}
const body = Buffer.concat(chunks)
// body: body.length > 0 ? body : undefined
```

**涉及文件**：`packages/server/src/index.ts`

---

### 4. 新建文件 10 秒延迟

**原因**：**React `useCallback` 闭包陷阱**。`handleCreateEntry` 依赖数组只有 `[id]`，不包含 `yDoc`。首次渲染时 `yDoc = null`，闭包永远捕获这个值。

```typescript
// ❌ yDoc 不在 deps → 永远捕获首次渲染时的 null
const handleCreateEntry = useCallback(async (...) => {
  if (yDoc) addToYTree(yDoc, ...)  // yDoc 永远为 null
}, [id])

// ✅ 添加 yDoc 到 deps
}, [id, yDoc])
```

这导致客户端乐观 Y.Map 写入（`addToYTree`）从未执行，一直在等 chokidar 慢速通道（fsevents + debounce + WS = ~200ms+），而 chokidar 的稳定性检测在特定场景下可达 10 秒。

**诊断方法**：在关键路径添加 `console.log` 埋点：
- `addToYTree` — 是否被调用
- `useYMap` observer — Y.Map 变化是否触发
- 服务端 `handleAdd` / `handleRemove` — chokidar 是否检测到
- 服务端 `doc.on("update")` — 更新是否广播

**涉及文件**：`packages/web-app/app/workspaces/[id]/page.tsx`

---

### 5. chokidar `repopulate` 导致 UI 闪烁

**原因**：旧方案 chokidar 事件触发 `repopulate` → `populateFromDisk` → `tree.clear()` + 全量重建。客户端收到「全部删除 + 全部添加」两波更新，文件树会闪烁。

**修复**：改为增量操作：
- `add` → `handleAdd` — 只添加单个文件到 Y.Map
- `unlink` → `handleRemove` — 只删除单个条目
- `change` → `handleChange` — 只更新 Y.Text 内容

**涉及文件**：`packages/server/src/services/yjs.ts`

---

### 6. 路由不匹配

**原因**：`app.route("/api/workspaces/:id/files", fileRoutes)` + `fileRoutes.post("/files", handler)` 实际路径为 `/api/workspaces/:id/files/files`，而 API client 调用的是 `/api/workspaces/:id/files`。

**修复**：将 `file-routes.ts` 的路径从 `"/files"` 改为 `"/"`。

**涉及文件**：`packages/server/src/routes/file-routes.ts`

---

### 7. TextEditorTab 脏检测失效

**原因**：`MonacoBinding` 直接绑定 Monaco Editor 到 Y.Text，编辑器变化不经过 React state → `fileContents` 不更新 → `isDirty()` 永远返回 false → 无橙色点、无保存按钮、关闭无提醒。

**修复**：在 `MonacoBinding` 激活时，添加 Y.Text observer 同步到 `fileContents` 状态：

```typescript
const observer = () => onContentChange?.(filePath, ytext.toString())
ytext.observe(observer)
```

**涉及文件**：`packages/web-app/components/workspace/text-editor-tab.tsx`

---

### 8. Watcher 从未启动（docs.set 顺序问题）— P0 核心功能完全失效

**现象**：文件新增/删除/修改在前端目录树完全不反映，刷新按钮除外。删除文件永远残留，新增文件 5-10 秒延迟。

**根因**：`startWatch` 通过 `getYDocForWorkspace()` 从 `docs` Map 间接查找 doc，但 `docs.set(roomName, room)` 在 `initWorkspaceRoom()` 之后才执行。`startWatch` 调用时 room 还不在 Map 里 → 查找返回 undefined → 直接 return → watcher 从未启动。

**修复**：`startWatch` 改为直接接收 `doc` 参数，不再从 `docs` Map 间接查找。删除 `getYDocForWorkspace` 函数。

**完整诊断过程（4 步排查、Node.js 诊断脚本验证、调用顺序追踪）详见 → [踩坑记录：Yjs 文件树变更不同步——watcher 从未启动](./yjs-file-tree-sync-bugfix-watch-ordering.md)**

**涉及文件**：`packages/server/src/services/yjs.ts`、`packages/server/src/routes/yjs-ws.ts`

---

## 性能优化

| 优化项 | 之前 | 之后 | 效果 |
|--------|------|------|------|
| chokidar debounce | 200-500ms | 50ms | 文件变更响应提升 4-10x |
| `awaitWriteFinish` | 100ms stability | 已移除 | 消除不必要的等待（API 写盘为原子操作） |
| chokidar 操作 | 全量 clear+rebuild | 增量 handleAdd/Change/Remove | 无 UI 闪烁，减少广播量 |
| ignored 模式 | 仅排除 .隐藏文件 | 排除 node_modules/target/dist/.next 等 + .class/.jar 等 | 构建时无海量事件冲击 |
| 客户端写入 | 仅 chokidar 回传 | 乐观 Y.Map + chokidar 双路径 | 创建/删除立即生效 |
| 刷新 | 无 | POST /refresh → Y.transact → 一次事务重建 | 手动修复不一致 |

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `packages/server/src/routes/yjs-ws.ts` | WebSocket 服务器，房间管理，协议处理 |
| `packages/server/src/services/yjs.ts` | Y.Map 操作，populateFromDisk，chokidar 监听 |
| `packages/server/src/routes/file-routes.ts` | 文件 CRUD REST API + refresh |
| `packages/server/src/services/file-service.ts` | 磁盘 I/O 服务（路径穿越防护） |
| `packages/web-app/lib/yjs-provider.ts` | React Hooks (useYDoc, useYMap) |
| `packages/web-app/components/workspace/sidebar-file-tree.tsx` | 文件树 UI 渲染 |
| `packages/web-app/components/workspace/text-editor-tab.tsx` | Monaco + Yjs 编辑器集成 |
| `packages/web-app/app/workspaces/[id]/page.tsx` | 工作空间页面，CRUD handlers |

---

## 环境配置

```bash
# 前端
NEXT_PUBLIC_WS_URL=ws://localhost:3001    # WebSocket 地址
NEXT_PUBLIC_SERVER_URL=http://localhost:3001  # REST API 地址

# 服务端
PORT=3001                                  # 服务端口
```