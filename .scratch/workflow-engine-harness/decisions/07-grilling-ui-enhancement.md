# 07 — Harness UI 增强

Type: grilling
Status: resolved
Blocked by: 01, 04

## Question

Harness 的监控面板在 UI 中怎么呈现？

## Answer

### UI 组件布局

#### 1. DAG 节点卡片标记
- 被 harness 干预过的节点显示 🛡️ 图标
- 状态文字变为 `harness_modified` / `harness_executed`
- 鼠标悬停显示干预摘要 tooltip
- 文件: `execution-node.tsx` (已有 StatusOverlay 注入点)

#### 2. LogViewer 增强
- 在已有的 harness_directive / heartbeat_stall 渲染基础上:
  - 新增 harness 事件过滤器 (只看 harness 相关事件)
  - 干预前后 diff 展示 (脚本修改前 vs 后, 变量修改前 vs 后)
  - harness 干预时间线 (检测 → 诊断 → 策略 → 干预 → 结果)
- 文件: `execution-log-viewer.tsx`

#### 3. Harness 悬浮面板 (核心新增组件)

**设计规格:**
- 悬浮窗口，可拖拽，可调整大小
- 默认位置: 右上角，不贴边
- **收起态**: 半透明小矩形，显示核心监控指标
  - 干预次数 (如 "🛡️ 2")
  - 当前状态 (如 "监控中" / "干预中")
  - 额外 token 消耗
- **展开态**: 详细悬浮窗口，包含:

**展开态 Tab 结构:**

| Tab | 内容 |
|-----|------|
| **监控** | 干预时间线 + 诊断报告列表 + 每次干预的状态流 |
| **明细** | 选中某次干预的详情: 检测器、诊断、策略、修改 diff、token |
| **Chatbot** | 对话界面，用户可以主动发送干预指令 |

**Chatbot 功能:**
- 用户通过对话主动干预 workflow 执行
- 底层调用 harness-intervene API
- 示例对话:
  - 用户: "告诉 bash-build 节点先跑 npm install"
  - 系统: 构造 harness-intervene 请求 → 注入指令 → 反馈结果
  - 用户: "暂停当前执行，我要看看变量池"
  - 系统: 调用 pause API → 显示当前 VarPool
- 显示 harness agent 分身的推理过程 (如果触发了 Layer 3 委托)

#### 4. Token 计费集成
- harness agent 分身的 token 独立记录
- 在悬浮面板的监控 Tab 中显示: "Harness 额外: ↑2K ↓500 ($0.03)"
- 在 workflow 总览中汇总: 原始执行 token + harness 干预 token
- CostPanel 组件 (已有但未渲染) 可以激活，加入 harness token

### 文件清单

| 新增/修改 | 文件 | 说明 |
|----------|------|------|
| 新增 | `components/workspace/harness-floating-panel.tsx` | 悬浮面板主组件 |
| 新增 | `components/workspace/harness-chatbot.tsx` | Chatbot 对话界面 |
| 新增 | `components/workspace/harness-timeline.tsx` | 干预时间线组件 |
| 新增 | `hooks/use-harness-events.ts` | Harness SSE 事件 hook |
| 修改 | `execution-node.tsx` | 添加 harness 标记 overlay |
| 修改 | `execution-log-viewer.tsx` | 添加 harness 过滤器 + diff |
| 修改 | `workflow-detail-panel.tsx` | 激活 CostPanel + 挂载悬浮面板 |
