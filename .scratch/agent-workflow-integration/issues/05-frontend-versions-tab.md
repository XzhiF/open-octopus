# 05 — Frontend: Clone Versions Tab + Version UI Components

## What to build
在现有分身管理页面（CloneDetailView）增加 Versions Tab，实现版本列表、版本详情、发布对话框、diff 对比、回滚操作。同时为 workflow 节点编辑器添加 OctopusAgentNode 组件。

## Blocked by
01 — Version Management Foundation (需要版本 API)
02 — Shared Types + Registration (需要 node-icon-config 和类型定义)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: CloneDetailView 新增 "Versions" Tab，与现有 File Tree / File Content / Chat Tab 并列
- [ ] AC2: VersionList 组件: 显示版本号 + stage badge (alpha/beta/rc/stable) + status badge (draft/published/archived) + 发布日期
- [ ] AC3: 点击版本行展开 VersionDetail: changelog + persona 查看 + config 查看 + diff 对比按钮 + 回滚按钮
- [ ] AC4: PublishVersionDialog: 输入 version (Maven 格式)、stage (下拉选择)、changelog (文本框)，调用 POST API
- [ ] AC5: VersionDiff 组件: 选择两个版本，显示 persona/config/skills 的 diff（使用现有 diff 库或简单 text diff）
- [ ] AC6: 回滚确认对话框 + 调用 rollback API + 成功后刷新版本列表
- [ ] AC7: Main Agent 在系统设置页 (/agent 页面的 Main Agent 区域) 增加同样的 Versions Tab
- [ ] AC8: OctopusAgentNode workflow 节点组件: 显示 agent name + version + task brief + heartbeat 进度（接收 agent_heartbeat SSE 事件）
- [ ] AC9: OctopusAgentNode 节点在 workflow 编辑器中可拖拽创建，配置面板支持 agent/version/task/harness 字段
- [ ] AC10: node-icon-config 中 octopus_agent 的 icon/color 在 UI 中正确渲染

## Verification Method
**Verification type**: browser E2E + visual regression

**Verification steps**:
```bash
# 1. 打开分身管理页面
# Navigate to /agent → 分身 Tab → 选择 workspace 分身
# Expect: 看到 Info / Skills / Memory / Versions 四个 Tab

# 2. 切换到 Versions Tab
# Expect: 版本列表渲染，如果无版本显示空状态

# 3. 点击 "Publish New Version"
# Expect: PublishVersionDialog 弹出，含 version/stage/changelog 表单

# 4. 填写并提交
# Expect: API 调用成功，版本列表刷新显示新版本

# 5. 点击版本行查看详情
# Expect: 展开显示 changelog + action buttons

# 6. 选择两个版本点 "Compare"
# Expect: diff 视图显示差异

# 7. 点 "Rollback" → 确认
# Expect: rollback API 调用成功，persona 恢复

# 8. 在 workflow 编辑器中拖入 octopus_agent 节点
# Expect: 节点渲染正确，配置面板显示所有字段

# 9. 执行包含 octopus_agent 的 workflow
# Expect: 节点卡片显示 heartbeat 进度信息
```

**Pass criteria**: All 10 ACs pass in browser, no console errors
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
