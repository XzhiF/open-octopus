---
name: octo-exp-interaction-node-switching
description: "经验记录：多交互节点切换时的 React 状态竞态、Claude SDK 幻觉、SSE 流污染等问题的排查与修复"
tags: [experience, debugging, react, claude-sdk, interaction-node, sse]
created: 2026-08-01
branch: feat/interaction-node
---

# 多交互节点切换踩坑记录

> 在 `pick-three` 工作流（颜色→动物→食物三连交互节点）中遇到的一系列问题。
> 每个问题的根因不同，但都与 **React 状态时序** 和 **Claude SDK agentic loop** 有关。

---

## 问题 1：Claude Agent 幻觉用户答案

### 症状
Agent 调用 AskUserQuestion 后，不等用户回答就自己编造了答案并输出完成 JSON。

### 根因
Claude SDK 的 agentic loop 中，模型在**同一个 turn** 里同时生成了 `text` 和 `tool_use`。
`PreToolUse` hook 的 deny 消息到达时，文本已经生成并发到前端。

```
模型生成: [thinking] → [text: "好的，已记录！"] → [tool_use: AskUserQuestion]
                                    ↑ 幻觉文本已输出
SDK 处理: PreToolUse deny → tool_result → 模型继续...（但文本已经发了）
```

### 无效尝试
1. **修改 system prompt**："Call and STOP" → 模型不遵守
2. **canUseTool 回调 deny** → `bypassPermissions` 模式下 canUseTool **不会被调用**
3. **精简 deny 消息** → 消息到达太晚，文本已生成

### 最终修复（确定性方案，不依赖模型行为）
**Server 端文本缓冲**：Round 1 缓冲所有 `text_delta`，不调度到前端。

```typescript
// InteractionService.ts — handleTextDelta
if (session.currentRound === 1) {
  if (acc.askUserQuestionCalled) return []  // AskUserQuestion 后的文本全部丢弃
  acc.textBuffer.push(event)                // 缓冲，不发送
  return []
}
```

当 AskUserQuestion 被调用时清空缓冲区：
```typescript
// handleAskUserQuestion
acc.askUserQuestionCalled = true
acc.textBuffer = []
acc.fullText = ""
```

### 教训
- **不要依赖模型行为来保证正确性**。prompt 指令是"建议"，不是"保证"。
- **确定性方案 > 概率性方案**：server 端过滤比 prompt 指令可靠 100 倍。
- `bypassPermissions` 会跳过 `canUseTool`，这是个坑。

---

## 问题 2：SDK Agentic Loop 重试导致重复消息

### 症状
AskUserQuestion 被调用多次（2-3 次），前端显示多个重复的问题卡片。

### 根因
SDK 的 agentic loop 在 PreToolUse deny 后**重试**工具调用，每次重试生成新的 thinking + tool_call。

### 修复
在 InteractionService 中去重：第一次 AskUserQuestion 后，跳过后续重复。

```typescript
// handleAskUserQuestion — 去重
if (acc.askUserQuestionCalled) return []  // 跳过重复

// handleToolCallStart — 跳过重复的 AskUserQuestion
if (chunk.toolName === 'AskUserQuestion' && acc.askUserQuestionCalled) {
  acc.toolCallMap.set(chunk.toolCallId, { dbId: '', ... })
  return []
}

// handleThinkingStart — 抑制重复 thinking
if (session.currentRound === 1 && acc.askUserQuestionCalled) {
  acc.thinkingMessageId = ""
  return []
}
```

### 教训
- SDK agentic loop 会重试被 deny 的工具。每次重试都是完整的 thinking → tool_call 周期。
- 必须在 server 端做去重，不能假设 SDK 只调用一次。

---

## 问题 3：节点切换时前端显示旧节点消息

### 症状
从 ask-color 切换到 ask-animal 时，弹窗里显示的还是颜色选择问题。

### 根因链（5 层问题逐层暴露）

#### 层 1：Hook 状态不重置
`useInteractionStream` 的 `loadedRef` 阻止了节点切换时的重新加载。

**修复**：用 `syntheticSessionId` 变化触发 reset。

#### 层 2：Optimistic 消息重复 key
`sendMessage` 创建的 `user-${Date.now()}` 和 DB 加载的 user 消息 ID 不同但内容相同 → React key 警告。

**修复**：`loadMoreMessages` 中按 role+content 去重 optimistic 消息。

#### 层 3：useEffect 执行顺序
Reset effect 和 auto-load effect 分开写时，auto-load 可能在 reset 之前触发。

**修复**：合并为单个 useEffect（先 reset，后 load）。

#### 层 4：TDZ 错误
合并后的 useEffect 引用了定义在后面的 `loadMoreMessages`（`const` 暂时性死区）。

**修复**：将 useEffect 移到 `loadMoreMessages` 定义之后。

#### 层 5：竞态 — Prompt 在 Reset 之前发送 ⭐ 核心问题
**`useEffect` 的 reset 在同 render 周期的其他 effects 之后执行**。
节点切换时，`sessionReady` 还是 `true`（来自旧节点），prompt send effect 先发送了 prompt，然后 reset effect 才清空消息。

```
Render 1 (nodeKey 变化):
  sessionReady = true (旧节点的值！)
  prompt send effect 触发 → sendMessage → 添加 optimistic 消息
  reset effect 触发 → setMessages([]) → 清空所有消息！
```

**修复**：用 React 官方推荐的 "render 期间调整 state" 模式同步重置。

```typescript
// 在 render 阶段同步重置（不是 useEffect！）
const nodeKey = `${executionId}-${nodeId}`
const prevNodeKeyRef = useRef(nodeKey)
if (prevNodeKeyRef.current !== nodeKey) {
  prevNodeKeyRef.current = nodeKey
  setSessionReady(false)      // 同步！在 render 中！
  setInitialPrompt(null)
}
```

保证时序：
```
Render: nodeKey 变化 → sessionReady=false (同步)
Effects: hook reset (messages=[]) → /start 调用
Re-render: /start 返回 → sessionReady=true → prompt send
```

### 教训
- **`useEffect` 不保证在同 render 周期内的执行顺序**（相对于其他组件的 effects）。
- 当状态必须在 effect 之前重置时，使用 **render 期间调整 state** 模式。
- `useRef` 跟踪前一个 prop 值是检测变化的标准模式。
- 时序问题的调试方法：在每个 effect 中加 `console.log` 并检查执行顺序。

---

## 问题 4：SSE Stream 污染

### 症状
旧节点的 SSE stream 数据出现在新节点的消息列表中。

### 根因
`sendMessage` 是 async 的。节点切换时旧 stream 仍在运行，`applyChunk` 回调持续调用 `setMessages`。

### 修复（3 层防护）
1. **Abort**：reset effect 中 `abortRef.current?.abort()`
2. **Chunk guard**：`guardedApplyChunk` 检查 `syntheticSessionIdRef`
3. **Finally guard**：`finally` 块只在 session 未变时更新 state

```typescript
const callSessionId = syntheticSessionId

const guardedApplyChunk = (chunk) => {
  if (callSessionId !== syntheticSessionIdRef.current) return
  applyChunk(chunk)
}

// finally block
if (callSessionId === syntheticSessionIdRef.current) {
  setIsStreaming(false)
  setStreamEndState(...)
}
```

### 教训
- **Async 操作必须有取消机制**。`AbortController` 是标准方案。
- 闭包捕获的值可能过时，用 `useRef` 获取最新值。
- `finally` 块也需要 guard — 节点切换后旧 stream 的 `finally` 不应该更新新节点的 state。

---

## 问题 5：globalSessionId 架构

### 设计决策
Interaction 节点默认共享 workflow 的 `globalSessionId`（`context: "continue"`），
只有指定 `context: new` 时才创建独立 session。

```yaml
nodes:
  - id: ask-color
    type: interaction        # 默认 context: continue → 共享 session
  - id: ask-animal
    type: interaction
    context: new             # 独立 session
```

### 实现
- `startInteraction` 接收 `globalSessionId` 和 `context`
- `context: "continue"` → `providerSessionId = globalSessionId`
- `context: "new"` → `providerSessionId = undefined`（SDK 创建新 session）
- 交互完成后，`providerSessionId` 写回 `execution.global_session_id`

### 教训
- 已有的 session 也要返回 `initialPrompt`（find-or-create 模式的常见遗漏）。
- Session 架构要和 agent 节点保持一致（`context: continue/new`）。

---

## 调试工具

### 前端日志标记
```typescript
console.log('[DEBUG-b7c3] prompt effect:', { sessionReady, hasPrompt, ... })
```
- 使用唯一前缀 `[DEBUG-xxx]` 方便 grep 清理
- 记录所有 effect 的触发时机和状态

### 后端验证脚本
```bash
bash scripts/test-interaction-hallucination.sh 10
```
- 自动创建 execution → start → send prompt → 检查结果
- 10 次循环验证修复的稳定性

### API 手动验证
```bash
curl -s -X POST ".../interactions/$EXEC_ID/ask-animal/start" -d '{"display":"modal"}'
```
- 直接调用 API 验证后端行为，隔离前端问题

---

## 关键 Commit 序列

| Commit | 问题 | 方案 |
|--------|------|------|
| `b8d7415` | 幻觉答案 | Round 1 文本缓冲 |
| `c3d2b6f` | 重复消息 | AskUserQuestion 去重 |
| `6da2ba8` | 节点切换不重置 | syntheticSessionId 触发 reset |
| `a858556` | React key 警告 | Optimistic 消息去重 |
| `aab160a` | Session 架构 | globalSessionId 支持 |
| `fe7e436` | NO_SESSION 错误 | ready gate |
| `216086e` | 空对话框 | Existing session 返回 initialPrompt |
| `af9c9df` | Stream 污染 | Abort + chunk guard |
| `95a88d4` | Prompt 在 reset 前发送 | Render 阶段同步重置 |

---

## 通用原则

1. **确定性 > 概率性**：server 端过滤比 prompt 指令可靠
2. **同步重置 > 异步重置**：render 阶段重置比 useEffect 重置更早
3. **Abort 一切 async**：节点切换时必须取消旧 stream
4. **Ref 追踪最新值**：async 闭包中的 state 可能过时，用 `useRef`
5. **去重在 server 端**：SDK agentic loop 会重试，server 必须幂等
6. **拆分 effects 要谨慎**：独立 effects 的执行顺序不保证
7. **日志标记 + 清理**：`[DEBUG-xxx]` 前缀方便事后清理
