# Requirement Brief: Clone UI Redesign

## Overview
重新设计分身管理 UI，采用文件系统为核心的 Agent-first 模型，提供 IDE 风格的三栏布局（文件树 | 文件内容 | Chat）。

## Projects Involved
- [x] packages/web-app (前端 UI 重构)
- [x] packages/server (API 简化，移除 project association)

## Feature Scope

**Do:**
- 三栏布局：文件树 | 文件内容编辑器 | Chat 面板
- Agent-first 技能管理：agent 在 chat 中自主创建/编辑/删除技能文件
- Agent-first 记忆管理：agent 在 chat 中读写记忆文件
- 继承资源标记：共享技能/记忆显示为只读引用
- 交互式创建流程：最小化表单 → 进入视图 → agent 引导完善 persona
- 精简分身卡片：name, display_name, status, memory_scope, last_active

**Don't:**
- 不保留项目关联功能（删除 workspace 字段）
- 不在创建时选择技能（留给 agent 后续管理）
- 不提供专门的技能选择器 UI
- 不改变后端文件系统架构（ADR-005/006 已正确）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | UI 模型 | 文件系统浏览器 | 用户选择：分身设计应以文件系统为主 |
| 2 | 布局 | 三栏（文件树 \| 内容 \| Chat） | 与 workspace 页一致，IDE 风格 |
| 3 | 技能管理 | Agent-first | Agent 在 chat 中自主管理 skills/ 目录 |
| 4 | 记忆管理 | Agent-first | Agent 在 chat 中读写 memory/ 文件 |
| 5 | 资源库 | 可选技能 | 不作为强制绑定，而是通过 octo-resource-manager 技能查询 |
| 6 | 项目关联 | 删除 | 用户认为没必要，移除 workspace 字段 |
| 7 | 继承资源 | 只读标记 | 共享技能/记忆显示为 "继承自 Main Agent（只读）" |
| 8 | 创建流程 | 交互式 | 最小表单 → 进入三栏视图 → agent 引导写 persona |
| 9 | 卡片信息 | 精简 | name, display_name, status, memory_scope, last_active |
| 10 | 验证 | Playwright E2E | 自动化测试关键流程 |

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| CloneInfo (type) | Remove | `workspace?: { name, path }` field |
| CreateCloneRequest | Remove | `workspace?` field |
| CloneWorkspaceRef | Delete | 整个类型定义（dead code） |
| CloneInfo | Add | `last_active?: string` (ISO timestamp) |

**Note**: 后端数据库无变更（CloneService 已存储所有字段，只是 API response 调整）

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | /api/clones | Server | `{ name, display_name, memory_scope? }` | CloneInfo | 移除 persona（agent 后续写）, 移除 workspace |
| GET | /api/clones/{name}/files | Server | `?recursive=true` | `{ files: FileInfo[] }` | 新增：递归列出分身目录文件树 |
| GET | /api/clones/{name}/files/{path} | Server | - | `{ content, path, size, readonly }` | 增强：返回 readonly 标记 |
| PUT | /api/clones/{name}/files/{path} | Server | `{ content }` | `{ success }` | 现有，不变 |
| DELETE | /api/clones/{name}/files/{path} | Server | - | `{ success }` | 新增：删除文件/目录 |
| POST | /api/clones/{name}/files/{path} | Server | `{ type: 'directory' }` | `{ success }` | 新增：创建目录 |

**FileInfo**: `{ path, name, type: 'file' | 'directory', size, modified, readonly }`

## Design Specs (if any)
- Figma link: none
- Fidelity: 参考 VS Code 文件树 + workspace 页三栏布局

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 作为用户，我想创建新分身 | 填 name + display_name → 创建成功 → 自动进入三栏视图 | Playwright: 创建流程 |
| 2 | 作为用户，我想浏览分身文件 | 文件树显示 persona.md, config.json, skills/, memory/ | Playwright: 文件树渲染 |
| 3 | 作为用户，我想查看共享资源 | 文件树底部显示 "继承自 Main Agent" 区块，包含 skills/ (只读) | Playwright: 继承资源标记 |
| 4 | 作为用户，我想编辑分身配置 | 点 persona.md → 中间面板显示内容 → 编辑 → 保存成功 | Playwright: 文件编辑 |
| 5 | 作为用户，我想和分身对话 | 右侧 Chat 面板可正常对话，agent 能操作文件 | Playwright: chat 交互 |
| 6 | 作为 agent，我想管理自己的技能 | Chat 中 agent 能创建 skills/my-skill/SKILL.md，文件树实时更新 | Playwright: agent 文件操作 |
| 7 | 作为用户，我想看分身概览 | 分身卡片显示 name, display_name, status, memory_scope, last_active | Playwright: 卡片渲染 |
| 8 | 作为用户，我想交互式完善分身 | 创建后 agent 主动问 "你想让我成为什么样的分身？"，用户描述后 agent 写 persona.md | Playwright: agent 引导流程 |

## Verification Strategy

### Global Config
- Environment: local dev
- Test user: default (no auth)
- Data prefix: `e2e-clone-test-`
- Cleanup: 测试后删除创建的测试分身

### Per-layer Methods

#### Unit Tests
- 文件树组件：展开/折叠、选中、只读标记
- API 响应转换：FileInfo 结构、readonly 判断逻辑
- 创建表单验证：name 格式、必填字段

#### Integration Tests
- `GET /api/clones/{name}/files?recursive=true` 返回正确文件树
- `POST /api/clones/{name}/files/{path}` 创建目录成功
- `DELETE /api/clones/{name}/files/{path}` 删除文件成功
- 共享技能路径返回 `readonly: true`

#### Browser E2E (Playwright)
```typescript
test('创建分身 → 进入三栏视图', async ({ page }) => {
  await page.goto('/agent?tab=clone')
  await page.click('button:has-text("创建分身")')
  await page.fill('input[name="name"]', 'e2e-test-clone')
  await page.fill('input[name="display_name"]', '测试分身')
  await page.click('button:has-text("创建")')
  await expect(page.locator('.file-tree')).toBeVisible()
  await expect(page.locator('.chat-panel')).toBeVisible()
})

test('文件树显示继承资源为只读', async ({ page }) => {
  await page.goto('/agent?tab=clone')
  await page.click('.clone-card:has-text("测试分身")')
  await expect(page.locator('.file-tree')).toContainText('继承自 Main Agent')
  const readonlySkill = page.locator('.file-item:has-text("octo-agent-memory")')
  await expect(readonlySkill).toHaveAttribute('data-readonly', 'true')
})

test('Agent 在 chat 中创建技能文件', async ({ page }) => {
  await page.goto('/agent?tab=clone')
  await page.click('.clone-card:has-text("测试分身")')
  await page.fill('.chat-input', '帮我创建一个名为 test-skill 的技能')
  await page.click('.send-button')
  await expect(page.locator('.file-tree')).toContainText('test-skill', { timeout: 30000 })
})
```

#### Contract Tests
- CloneInfo TypeScript 类型 ↔ API response JSON 字段一致性
- FileInfo 类型 ↔ `/api/clones/{name}/files` response 一致性

#### Manual Checklist
- [ ] 文件树能展开/折叠目录
- [ ] 点文件能在中间面板查看内容
- [ ] 编辑文件能保存
- [ ] 共享技能显示为只读（不可编辑/删除）
- [ ] Chat 面板能正常对话
- [ ] Agent 操作文件后文件树实时更新

### Prerequisites
- [ ] 后端实现 `GET /api/clones/{name}/files?recursive=true`
- [ ] 后端实现 `POST /api/clones/{name}/files/{path}` (创建目录)
- [ ] 后端实现 `DELETE /api/clones/{name}/files/{path}`
- [ ] 后端判断 readonly 逻辑（路径在 `~/.octopus/agent/skills/` 或 `memory/` 下）

## Risks & Notes

- R1: 文件树实时更新需要 WebSocket 或轮询机制（当前无 live reload）
- R2: Agent 创建/删除文件后，前端需要刷新文件树（可能延迟）
- R3: 大文件编辑（>100KB）可能卡顿，需要懒加载或分片
- R4: 只读标记逻辑需要后端明确判断规则

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| Agent-first | 设计模式：agent 是资源的主要管理者，UI 提供查看/辅助编辑能力 |
| 继承资源 | 来自 Main Agent 的共享技能/记忆，分身可以读取但不能修改 |
| 三栏布局 | IDE 风格界面：左侧文件树、中间文件内容、右侧 Chat 面板 |
| 交互式创建 | 创建流程：最小化表单 → 进入视图 → agent 在 chat 中引导完善配置 |
