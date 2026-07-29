# Requirement Brief

## Overview
优化 Agent Config 模块的前端 UX，修复 toast 反馈系统 bug，增强调试日志交互能力，并让 Agent 感知通知渠道配置。

## Projects Involved
- [x] packages/web-app (前端 UI 改动)
- [x] packages/server (后端 API 增强)
- [x] packages/core-pack (新增 octo-notify skill)

## Feature Scope

**Do:**
- 修复 toast 反馈系统 — 在根布局挂载 `<Toaster>`，清理 Radix toast 死代码
- Debug Mode 位置重组 — 从 GeneralConfig 移到 DebugLogViewer 顶部
- 调试日志增强 — 后端真分页 + 前端加载更多 + 基础搜索
- System Prompt 详情 — 后端返回完整 content + 前端可折叠显示
- 面板布局重排 — 按场景分组（通用→人格→通知→记忆→安全组→调试）
- 创建 octo-notify skill — 让 Agent 感知并主动使用通知渠道

**Don't:**
- 不重构后端业务逻辑（已实现完整）
- 不新增配置项
- 不做多语言国际化

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 01 | Debug Mode 位置 | 移到 DebugLogViewer 顶部 | 开关和日志逻辑一体 |
| 02 | 保存反馈 | 根布局加 Toaster + 清理死代码 | 根因是 Toaster 未挂载 |
| 03 | 调试日志增强 | MVP: 分页+搜索 | 平衡改动量和体验 |
| 04 | Prompt 详情 | 可折叠+完整 content | 改动适中，满足需求 |
| 05 | 通知感知 | 创建 octo-notify skill | Agent 可主动通知 |
| 06 | 面板布局 | 按场景分组 | 安全组放一起，调试放最后 |

## Decision Map Summary

| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | Debug Mode 位置 | grilling | 移到调试日志面板顶部 |
| 02 | 保存反馈 | research+grilling | 根布局 Toaster + 清理 Radix toast |
| 03 | 调试日志增强 | grilling | MVP 分页+搜索 |
| 04 | Prompt 详情 | grilling | 可折叠+完整 content |
| 05 | 通知感知 | grilling | 创建 octo-notify skill |
| 06 | 面板布局 | grilling | 按场景分组重排 |

Map: [map.md](./map.md)

## Data Model Changes

无数据库 schema 变更。

### API 变更

| Method | Path | Change | Details |
|--------|------|--------|---------|
| `GET` | `/api/agent/debug/log` | 增强 | 实现真 cursor-based 分页，支持 `cursor` 参数 |
| `GET` | `/api/agent/debug/assemble/:chat_id` | 增强 | 返回完整 `content` 字段而非 200 字符 preview |

### 类型变更

```typescript
// DebugSegment 新增 content 字段
export interface DebugSegment {
  index: number
  name: string
  token_count: number
  budget: number
  degraded: boolean
  content_preview: string  // 保留，前 200 字符
  content: string          // 新增，完整内容
}
```

## API Contracts

### GET /api/agent/debug/log (增强)

**新增/修改参数:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | 每页条目数 (max 100) |
| `cursor` | string | - | 分页游标 (timestamp-based) |
| `search` | string | - | 关键词搜索 |
| `start_date` | string | - | 起始日期 ISO 格式 |
| `end_date` | string | - | 结束日期 ISO 格式 |

**Response:**
```json
{
  "items": [...],
  "total": 150,
  "has_more": true,
  "next_cursor": "2026-07-29T10:30:00Z"
}
```

### GET /api/agent/debug/assemble/:chat_id (增强)

**Response 变更:**
每个 segment 新增 `content` 字段（完整内容），保留 `content_preview`（前 200 字符）。

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|----|
| AC-01 | 保存配置后看到反馈 | 点击任意保存按钮，出现 toast 通知(成功/失败) | Browser E2E |
| AC-02 | Debug Mode 在调试日志面板 | DebugLogViewer 顶部有 Debug Mode 开关，GeneralConfig 不再有 | Visual check |
| AC-03 | 调试日志分页 | 点击"加载更多"显示更多条目，URL 不变 | Browser E2E |
| AC-04 | 调试日志搜索 | 输入关键词后列表过滤，显示匹配条目 | Browser E2E |
| AC-05 | Prompt 详情可折叠 | 每个 segment 默认折叠显示 preview，点击展开显示完整内容 | Browser E2E |
| AC-06 | Prompt 详情可滚动 | 右侧详情面板内容超出时可滚动 | Visual check |
| AC-07 | 面板顺序正确 | 7 个面板按场景分组排列 | Visual check |
| AC-08 | Agent 知道通知能力 | Agent 回复中提及通知功能 | Manual check |
| AC-09 | PersonaEditor error toast | 人格设定保存失败时显示 error toast | Browser E2E |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`)
- Test user: default agent
- URL: `http://localhost:3000/agent?tab=config`

### Per-layer Methods

#### Unit Tests
- 后端 `AgentService.getDebugLog()` 分页逻辑测试
- 后端 `AgentService.getAssembleDetail()` 返回 content 字段测试

#### Integration Tests
- `GET /debug/log` 分页参数验证
- `GET /debug/assemble/:chat_id` content 字段验证

#### Browser E2E
- Toast 显示: 保存成功/失败场景
- Debug Mode 位置: DebugLogViewer 顶部可见
- 分页: 加载更多按钮功能
- 搜索: 关键词过滤功能
- 折叠: segment 展开/折叠交互
- 面板顺序: 7 个面板排列正确

#### Manual Checklist
- [ ] 所有 7 个面板的保存按钮都有 toast 反馈
- [ ] Debug Mode 开关在调试日志面板顶部
- [ ] 调试日志可以加载更多
- [ ] 调试日志可以搜索关键词
- [ ] System Prompt segment 可以展开查看完整内容
- [ ] 右侧详情面板可滚动
- [ ] 面板顺序: 通用→人格→通知→记忆→降级→审计→调试
- [ ] Agent 对话中知道通知渠道功能

### Prerequisites
- [ ] `pnpm build` 通过
- [ ] `pnpm dev` 启动成功
- [ ] 至少有一条调试日志记录（需先进行一次 Agent 对话）

## Risks & Notes

- R1: 后端 JSONL 文件全量读取改为真分页可能影响性能 — 需要评估文件数量和大小
- R2: Radix toast 死代码清理可能影响 scheduler 页面 — 需同步迁移到 sonner
- R3: octo-notify skill 需要与 NotificationService 集成 — 需确认调用方式

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| ConfigTab | Agent 配置页面，包含 7 个配置面板 |
| ConfigSection | 共享的卡片容器组件，用于包裹每个配置面板 |
| DebugLogViewer | 调试日志查看器，master-detail 布局 |
| SafeModePanel | 安全降级面板，14天不活跃自动启用 |
| SystemPromptAssembler | 系统提示词组装器，7 个优先级段 |
| octo-notify | 新增 skill，让 Agent 感知通知渠道 |
