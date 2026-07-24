# Requirement Brief

## Overview
分身管理增强 + @@mention 委托机制：区分系统/用户分身，修复创建流程，新增文件管理，实现 @@分身ID 跨分身委托的 MVP 使用场景。

## Projects Involved
- [x] server (API 统一 + @@mention 后端处理 + 文件管理 API)
- [x] web-app (UI 分区 + 创建向导改造 + @@mention 前端拦截 + 文件管理面板)

## Feature Scope
**Do:**
- 分身列表页分区展示（系统分身 / 用户分身）
- 用户分身创建向导改造（2 步：必填 + 可选，技能动态加载）
- 分身文件管理（persona.md / config.json / memory/ 查看与编辑）
- @@mention 委托机制（前端拦截 + 后端 CloneRuntime 执行）
- @@mention 自动补全（输入 @@ 弹出分身列表）
- 统一分身 API（合并两套为一套文件系统 API）
- 分身显示名称（display_name）

**Don't:**
- 不做 Playwright 浏览器自动化
- 不做分身权限/角色系统
- 不做分身间协作/多分身并行
- 不改 Workspace/Scheduler 专属页面的现有聊天行为
- 不做分身 marketplace / 分享

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | @@委托机制 | 前端拦截 + `delegate_to` 字段 + 后端直接调 CloneRuntime | 确定性委托，不依赖 LLM 理解 @@语法，用户无感知 |
| D2 | @@作用范围 | 所有聊天页面可用；禁止自引用（no-op）；禁止向上委托 Main Agent | 灵活但防止无限嵌套 |
| D3 | 创建流程 | 2 步向导：必填（英文代号 + 显示名称 + 人格）+ 可选（技能 + 空间 + 记忆） | 降低门槛，技能不应强制 |
| D4 | 文件管理 | 所有分身（内置 + 用户）均可编辑 persona/config/memory | 不做只读限制 |
| D5 | UI 布局 | 分区展示：系统分身（上，固定 4 个）+ 用户分身（下，可创建删除） | 直观区分，内置分身不可删除 |
| D6 | 存储策略 | 文件系统为源（persona.md + config.json），DB 仅存会话/消息 | 避免冗余，内置/用户统一机制 |
| D7 | API 统一 | 合并旧 /api/agent/clones + 新 /api/clones 为一套文件系统 API | 消除双系统并行 |
| D8 | 验证策略 | 集成测试 + 手动检查 | MVP 够用，不做 Playwright |

## Data Model Changes
| Table/File | Operation | Details |
|------------|-----------|---------|
| `clones/{name}/config.json` | ADD field | `display_name: string` — 分身显示名称 |
| `built-in/{name}/config.json` | ADD field | `display_name: string` — 内置分身显示名称 |
| `clones` DB table | DEPRECATE | 分身定义不再存 DB，仅会话/消息存 DB |
| `sessions` table | UNCHANGED | 已有 `clone_name`, `scope_id`, `provider_session_id` |
| `messages` table | UNCHANGED | 已有 `type`, `metadata` |

### config.json 结构（新增 display_name）

```json
{
  "display_name": "我的助手",
  "model": "claude-sonnet-4-20250514",
  "max_turns": 50,
  "tools": [],
  "memory_scope": "isolated",
  "skills": []
}
```

## API Contracts

### 统一分身 API（合并后的 /api/clones）

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/clones` | 后端 | — | `{ clones: CloneInfo[] }` | 读文件系统，返回内置+用户分身 |
| POST | `/api/clones` | 后端 | `{ name, display_name, persona, skills?, workspace?, memory_scope? }` | `{ clone: CloneInfo }` | 创建用户分身目录 + config.json + persona.md |
| GET | `/api/clones/:name` | 后端 | — | `{ clone: CloneInfo }` | 获取单个分身详情 |
| DELETE | `/api/clones/:name` | 后端 | — | `{ ok }` | 删除用户分身（内置不可删） |
| GET | `/api/clones/:name/files` | 后端 | `?path=` | `{ files: FileInfo[] }` | 列出分身文件（persona.md, config.json, memory/） |
| GET | `/api/clones/:name/files/:path` | 后端 | — | `{ content: string }` | 读取文件内容 |
| PUT | `/api/clones/:name/files/:path` | 后端 | `{ content: string }` | `{ ok }` | 写入文件内容（白名单路径） |

### @@mention 委托 API

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | `/api/agent/chat` | 后端 | `{ message, session_id?, delegate_to?: string }` | SSE stream | 新增 `delegate_to` 字段，有值时直接调 CloneRuntime |

### 废弃 API

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/agent/clones` | 旧创建 API，合并到 `POST /api/clones` |
| DELETE | `/api/agent/clones/:name` | 旧删除 API，合并到 `DELETE /api/clones/:name` |
| POST | `/api/agent/clones/:name/delegate` | 旧委托 API，被 `POST /api/agent/chat { delegate_to }` 替代 |
| POST | `/api/agent/clones/:name/merge` | 暂保留，后续迭代处理 |

### CloneInfo 响应类型

```typescript
interface CloneInfo {
  name: string              // 英文代号
  display_name: string      // 显示名称
  type: 'built-in' | 'user' // 分身类型
  persona: string           // 人格摘要（前 200 字）
  skills: string[]          // 技能列表
  memory_scope: 'shared' | 'isolated'
  workspace?: { name: string; path: string }
  status: 'active' | 'idle' | 'executing'
  created_at?: string
  last_active?: string
}
```

### @@mention 前端行为

```
用户输入 @@ →
  1. 前端检测 @@ 模式
  2. 调 GET /api/clones 获取分身列表（缓存）
  3. 弹出自动补全下拉（显示 display_name + name + type badge）
  4. 用户选择分身 → 输入框变为 @@scheduler [message...]
  5. 发送时：
     - 解析出 clone_name = "scheduler"
     - 剥离 @@scheduler 前缀，提取纯消息
     - POST /api/agent/chat { message: "纯消息", delegate_to: "scheduler", session_id }
  6. 响应显示：
     - 用户消息保留原始 @@syntax 显示
     - 分身回复带 source badge: [scheduler 🤖] 回复内容
```

### @@mention 规则

| 规则 | 说明 |
|------|------|
| 作用范围 | 所有聊天页面（主对话、分身聊天、Workspace/Scheduler 页面） |
| 自引用 | no-op — 如果当前在 scheduler 聊天中 @@scheduler，当作普通消息处理 |
| 向上委托 | 禁止 — 分身不能 @@Main Agent，前端不显示 Main Agent 在补全列表中 |
| 不存在的分身 | 前端提示 "分身不存在"，不发送请求 |
| 嵌套委托 | 不嵌套 — 分身收到委托后的回复不再解析 @@mention |

## Design Specs (if any)
- Figma link: none
- Fidelity: 与现有 Agent 页面风格一致即可

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-01 | 用户打开分身管理页 | 系统分身区域显示 4 个内置分身（workspace/scheduler/archive/resource），用户分身区域显示用户创建的 | 手动检查 + 截图 |
| AC-02 | 用户创建用户分身 | 2 步向导：Step1 填代号+名称+人格 → Step2 可选技能/空间/记忆 → 创建成功 | 手动检查创建流程 |
| AC-03 | 创建分身不强制技能 | 技能列表从 API 动态加载，可以为空，创建成功 | API 集成测试 |
| AC-04 | 内置分身不可删除 | 内置分身卡片无删除按钮或删除按钮 disabled | 手动检查 |
| AC-05 | 用户可编辑分身文件 | 点击分身管理按钮 → 查看/编辑 persona.md + config.json，保存后生效 | 手动检查 + API 测试 |
| AC-06 | @@mention 自动补全 | 输入 @@ 弹出分身下拉列表，选择后填入 @@name | 手动检查 |
| AC-07 | @@mention 委托执行 | 发送 @@scheduler 消息 → 分身回复内联显示，带 source badge | API 集成测试 + 手动检查 |
| AC-08 | @@mention 自引用安全 | 在 scheduler 聊天中 @@scheduler → 当作普通消息，不嵌套 | API 集成测试 |
| AC-09 | @@mention 禁止向上委托 | 分身聊天中 @@补全列表不包含 Main Agent | 手动检查 |
| AC-10 | 统一 API | GET /api/clones 返回内置+用户分身，type 字段区分 | API 集成测试 |
| AC-11 | 分身显示名称 | 分身卡片和 @@补全显示 display_name，不是英文代号 | 手动检查 |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev --isolated`)
- Test user: default org
- Data prefix: `E2E_CLONE_`（创建测试分身用前缀，清理用）

### Per-layer Methods
#### Unit Tests
- `resolveCloneDef()` 能正确区分内置/用户分身
- config.json 读写 display_name
- @@mention 解析函数（提取 clone_name + 纯消息）

#### Integration Tests
- `POST /api/clones` 创建用户分身（无技能也能创建）
- `GET /api/clones` 返回 4 内置 + N 用户分身
- `DELETE /api/clones/:name` 用户分身可删，内置返回 403
- `GET/PUT /api/clones/:name/files/:path` 文件读写（白名单路径）
- `POST /api/agent/chat { delegate_to }` 委托执行返回分身回复
- `POST /api/agent/chat { delegate_to: "self" }` 自引用返回普通回复

#### Manual Checklist
- [ ] 分身列表页分区正确（系统 4 个 + 用户 N 个）
- [ ] 创建向导 2 步可用，技能可不选
- [ ] 分身文件管理面板可编辑 persona.md
- [ ] @@ 弹出补全，选择后发送，分身回复带 badge
- [ ] 内置分身删除按钮不可用
- [ ] display_name 在卡片和补全中正确显示

### Prerequisites
- [ ] 前一个 PR (#30) 已合并到 main ✅
- [ ] `pnpm build` 通过
- [ ] `pnpm dev --isolated` 可启动

## Risks & Notes
- R1: 旧 /api/agent/clones 路由有其他页面调用（如 Agent 对话页的 PerspectiveIndicator），迁移时需要一并切换
- R2: 文件管理 API 需要路径白名单，防止 `../../` 目录穿越
- R3: @@mention 前端解析需要考虑多行消息、代码块内的 @@ 不应触发
- R4: 两套 API 合并时，前端 `lib/agent/api.ts` 中的 clone 相关调用需要统一切换
- R5: `PerspectiveIndicator` 目前未接线，这次可以顺手激活（作为 @@mention 的补充：手动切换视角）

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| 英文代号 (name) | 分身的唯一标识符，`/^[a-z0-9-]+$/`，用于文件路径和 API 路由 |
| 显示名称 (display_name) | 分身在 UI 和 @@mention 补全中展示的名称，支持中文 |
| @@mention | 用户在聊天中输入 `@@分身代号` 触发委托调用的语法 |
| 委托 (delegate) | 当前聊天 Agent 将消息转发给指定分身处理，分身回复内联显示 |
| 自引用 (self-reference) | 分身 A 聊天中 @@分身A，应忽略委托，当作普通消息 |
| 向上委托 (upward delegation) | 分身试图委托给 Main Agent，被禁止 |
| 文件白名单 (file whitelist) | 分身文件管理 API 允许读写的路径列表，防止目录穿越 |
