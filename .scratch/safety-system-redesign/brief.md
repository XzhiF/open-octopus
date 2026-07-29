# Requirement Brief

## Overview
诚实简化安全系统 — 补齐 safe_mode 对 evolution/scheduler 的检查，将"安全审计"改名为"操作审计"，让每个声称的安全能力都真正生效。

## Projects Involved
- [x] packages/server (evolution-service + scheduler-engine 加 safe_mode 检查)
- [x] packages/web-app (SafetyAudit 改名 + 文案调整)

## Feature Scope

**Do:**
- evolution-service.ts 的 reflect() 和 processUnprocessedMarks() 加 safe_mode 检查
- scheduler-engine.ts 的 triggerSchedule() 加 safe_mode 检查
- SafetyAudit 组件标题改为"操作审计"
- 移除 SafetyAudit 中"拦截"相关的描述文案
- SafeModePanel 说明文字保持不变（补齐检查后自然准确）

**Don't:**
- 不实现 tool 级拦截（保留 bypassPermissions 现状）
- 不添加 permission_mode 配置开关
- 不修改 Claude SDK provider
- 不改动 SafetyInterceptor 逻辑（保留为审计日志记录）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 01 | 整体方案 | A: 诚实简化 | 用户日常用 bypass 模式，完整安全管线 ROI 低 |
| 02 | 安全审计 UI | 改名为"操作审计" + 保留 | 诚实定位为事后追溯日志 |
| 03 | SafeMode 文案 | 保留现有 | 补齐检查后文案自然准确 |

## Data Model Changes

无 schema 变更。

## API Contracts

### 行为变更

| Endpoint | Change |
|----------|--------|
| `POST /evolution/feedback` | safe_mode 启用时返回 409 |
| `POST /evolution/process-marks` | safe_mode 启用时返回 409 |
| `POST /self-check/evolve` | safe_mode 启用时返回 409 |
| Scheduler cron trigger | safe_mode 启用时跳过执行，记录 skip 日志 |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|----|
| AC-01 | safe_mode 下 evolution 暂停 | safe_mode 启用时调用 /evolution/feedback 返回 409 | Integration Test |
| AC-02 | safe_mode 下 process-marks 暂停 | safe_mode 启用时调用 /evolution/process-marks 返回 409 | Integration Test |
| AC-03 | safe_mode 下 scheduler 跳过 | safe_mode 启用时定时任务不执行 | Unit Test (mock safe_mode) |
| AC-04 | safe_mode 解除后恢复 | safe_mode 关闭后 evolution/scheduler 恢复正常 | Integration Test |
| AC-05 | 操作审计标题 | UI 显示"操作审计"而非"安全审计" | Visual Check |
| AC-06 | 操作审计无拦截文案 | 事件列表中无"拦截"字样，改为"已记录" | Visual Check |
| AC-07 | SafeMode 文案准确 | 激活时显示 "SKILL 进化已暂停，定时任务熔断，写操作被限制为只读模式" | Visual Check |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`)
- URL: `http://localhost:3000/agent?tab=config`

### Per-layer Methods

#### Unit Tests
- evolution-service: mock safe_mode=true → reflect() 返回 blocked
- scheduler-engine: mock safe_mode=true → triggerSchedule() 跳过

#### Integration Tests
- `POST /evolution/feedback` + safe_mode=true → 409
- `POST /evolution/process-marks` + safe_mode=true → 409
- `POST /self-check/evolve` + safe_mode=true → 409

#### Browser E2E
- 打开 Config 页面 → 确认标题是"操作审计"
- 启用 safe_mode → 确认 SafeModePanel 文案
- 确认操作审计事件列表无"拦截"文案

#### Manual Checklist
- [ ] safe_mode 启用后 evolution API 返回 409
- [ ] safe_mode 启用后定时任务不触发
- [ ] safe_mode 解除后功能恢复
- [ ] "操作审计"标题显示正确
- [ ] 事件列表描述文案已更新

### Prerequisites
- [ ] `pnpm build` 通过
- [ ] `pnpm dev` 启动成功

## Risks & Notes
- R1: scheduler 跳过执行时应该记录 skip 日志，避免静默跳过难以排查
- R2: evolution 的 HTTP 路由有多个入口（feedback、process-marks、self-check），需要全部覆盖

## Glossary

| Term | Meaning |
|------|---------|
| 操作审计 | 原"安全审计"，事后追溯日志，记录 agent 操作事件 |
| safe_mode | 安全降级模式，限制 agent 写操作和后台任务 |
