# 08 — UI: 悬浮面板 + DAG 标记 + LogViewer 增强

## What to build
Web-app 三个 UI 增强: 悬浮面板（可拖拽/缩放/chatbot）、DAG 节点 harness 标记、LogViewer harness 过滤器。

## Blocked by
03 (harness events via SSE), 06 (API routes for events + intervene)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `HarnessFloatingPanel` 组件 — 默认右上角，不贴边，可拖拽，可缩放
- [ ] AC2: 收起态: 半透明小矩形 (48x120px)，显示干预次数 + 状态 + 额外 token
- [ ] AC3: 展开态: 三个 Tab (监控/明细/Chatbot)
- [ ] AC4: 监控 Tab: 干预时间线 + 诊断报告列表 + 统计汇总
- [ ] AC5: 明细 Tab: 选中干预的详情 (检测器/策略/动作/修改 diff/token)
- [ ] AC6: Chatbot Tab: 对话界面 + 发送干预指令 → 调用 harness-intervene API (type: "inject")
- [ ] AC7: DAG 节点卡片: harness 干预过的节点显示 🛡️ 图标 + harness_status 文字
- [ ] AC8: LogViewer: 新增 harness 事件过滤器 + harness_directive 渲染增强 + diff 展示
- [ ] AC9: Token 显示: harness agent 额外 token 在悬浮面板和节点详情中显示

## Verification Method
**Verification type**: browser E2E (Playwright)

**Verification steps**:
1. 启动 dev → 打开 workflow 执行页面
2. 验证悬浮面板收起态显示 → 点击展开 → 拖拽 → 缩放
3. 触发 harness 干预 → 验证监控 Tab 显示时间线
4. Chatbot 输入干预指令 → 验证 API 调用成功
5. DAG 节点显示 🛡️ 标记
6. LogViewer 过滤 harness 事件

**Pass criteria**: 所有 UI 交互正常工作
