# Verified Spec: Clone UI Redesign

## Overview
重新设计分身管理 UI，采用三栏布局（文件树 | 文件内容 | Chat），实现 Agent-first 技能和记忆管理模型。

## Architecture Changes

### Backend (packages/server)

#### 1. File Tree API
新增 `/api/clones/:name/files` 端点，递归列出分身目录。

**Request**: `GET /api/clones/:name/files?recursive=true`

**Response**:
```typescript
{
  files: Array<{
    path: string        // 相对路径: "persona.md", "skills/my-skill/SKILL.md"
    name: string        // 文件名: "persona.md", "SKILL.md"
    type: 'file' | 'directory'
    size: number        // 文件大小 (bytes), 目录为 0
    modified: string    // ISO timestamp
    readonly: boolean   // 是否只读（继承资源）
  }>
}
```

**Readonly 逻辑**:
- `~/.octopus/agent/skills/*` → readonly: true（共享技能）
- `~/.octopus/agent/memory/*` → readonly: true（共享记忆）
- `clones/{name}/*` → readonly: false（分身专属）
- `built-in/{name}/*` → readonly: false（系统分身专属）

#### 2. File Operations
增强现有文件 API：

**Create Directory**: `POST /api/clones/:name/files/:path`
```typescript
// Request
{ type: 'directory' }

// Response
{ success: true, path: string }
```

**Delete File/Directory**: `DELETE /api/clones/:name/files/:path`
```typescript
// Response
{ success: true }
```

**Enhanced Get**: `GET /api/clones/:name/files/:path`
```typescript
// Response (existing, add readonly)
{
  content: string
  path: string
  size: number
  readonly: boolean  // NEW
}
```

#### 3. Simplified Clone Creation
修改 `POST /api/clones`：

**Before**:
```typescript
{
  name: string
  display_name: string
  persona: string          // REMOVE
  skills?: string[]        // REMOVE
  workspace?: {...}        // REMOVE
  memory_scope?: 'shared' | 'isolated'
}
```

**After**:
```typescript
{
  name: string
  display_name: string
  memory_scope?: 'shared' | 'isolated'  // default: 'isolated'
}
```

创建时自动生成：
- `clones/{name}/persona.md`（空模板）
- `clones/{name}/config.json`（默认配置）
- `clones/{name}/skills/`（空目录）
- `clones/{name}/memory/`（空目录）

#### 4. Type Cleanup
- 删除 `CloneWorkspaceRef` 类型
- 从 `CloneInfo` 删除 `workspace` 字段
- 从 `CreateCloneRequest` 删除 `persona`, `skills`, `workspace` 字段
- 保留 `CloneInfo.last_active` 字段（已存在）

### Frontend (packages/web-app)

#### 1. Three-Column Layout
新建 `CloneDetailView` 组件，替换当前 `CloneChatView`。

**Layout**:
```
┌─────────────┬──────────────────┬─────────────┐
│  File Tree  │  File Content    │    Chat     │
│  (240px)    │  (flex-1)        │   (400px)   │
│             │                  │             │
│  - 分身文件  │  选中文件的内容    │  Agent 对话  │
│  - 继承资源  │  (编辑器/预览)    │  (SSE 流)   │
└─────────────┴──────────────────┴─────────────┘
```

**State Management**:
```typescript
const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
const [fileTree, setFileTree] = useState<FileInfo[]>([])
const [activePanel, setActivePanel] = useState<'content' | 'chat'>('chat')
```

#### 2. File Tree Component
新建 `CloneFileTree` 组件，VS Code 风格。

**Props**:
```typescript
interface CloneFileTreeProps {
  cloneName: string
  files: FileInfo[]
  selectedFile: FileInfo | null
  onSelectFile: (file: FileInfo) => void
  onRefresh: () => void
}
```

**Features**:
- 目录展开/折叠
- 文件图标（Markdown、JSON、目录）
- 只读标记（锁图标 + 灰色文字）
- 右键菜单：新建文件、新建目录、删除（只读禁用）
- 继承资源区块："继承自 Main Agent（只读）"

#### 3. File Content Panel
新建 `CloneFileContent` 组件。

**Props**:
```typescript
interface CloneFileContentProps {
  file: FileInfo | null
  cloneName: string
  onSave: (content: string) => void
}
```

**Features**:
- 文件不存在时显示空状态
- 选中文件时加载内容
- Markdown 文件：编辑模式（textarea）+ 预览模式
- JSON 文件：语法高亮编辑
- 只读文件：禁用编辑，显示"只读"徽章
- 保存按钮（有未保存更改时启用）

#### 4. Simplified Creation Wizard
修改 `CloneCreateWizard`，移除 Step 2（技能选择）。

**Before**: 2 步（基本信息 + 技能/记忆）
**After**: 1 步（仅 name + display_name）

```typescript
// Step 1 only
<input name="name" pattern="^[a-z0-9-]+$" />
<input name="display_name" />
// memory_scope 默认 'isolated'，不显示
```

创建成功后：
- 关闭 wizard
- 自动进入新分身的三栏视图
- Chat 中 agent 主动问 "你想让我成为什么样的分身？"

#### 5. Updated Card Display
修改 `CloneCardGrid`，简化信息展示。

**Remove**:
- 技能数量徽章（"3 技能"）
- Persona 预览

**Keep**:
- display_name + name
- 状态徽章（active/idle/executing）
- 记忆范围徽章

**Add**:
- 最后活跃时间（相对时间："2 小时前"）

#### 6. Navigation Flow
修改 `CloneTab` 导航逻辑。

**Current**:
```
CloneTab → click card → CloneChatView (三栏 chat 布局)
```

**New**:
```
CloneTab → click card → CloneDetailView (文件树 | 内容 | Chat)
         → click "文件管理" → CloneDetailView (same)
```

移除 `CloneFilePanel`（侧滑面板），替换为完整的三栏视图。

#### 7. API Client Updates
修改 `lib/agent/api.ts`：

```typescript
// New
listCloneFiles(name: string, recursive?: boolean): Promise<{ files: FileInfo[] }>
createCloneDirectory(name: string, path: string): Promise<{ success: boolean }>
deleteCloneFile(name: string, path: string): Promise<{ success: boolean }>

// Modified
createClone(req: { name, display_name, memory_scope? }): Promise<CloneInfo>  // removed persona, skills, workspace

// Enhanced
getCloneFile(name, path): Promise<{ content, path, size, readonly }>  // added readonly
```

## Implementation Order

### Ticket 1: Backend File Tree API
- 实现 `GET /api/clones/:name/files?recursive=true`
- Readonly 检测逻辑
- 单元测试

### Ticket 2: Backend File Operations
- 实现 `POST /api/clones/:name/files/:path` (create directory)
- 实现 `DELETE /api/clones/:name/files/:path`
- 增强 `GET /api/clones/:name/files/:path` (add readonly)
- 单元测试

### Ticket 3: Backend Simplified Creation
- 修改 `POST /api/clones` 移除 persona/skills/workspace
- 自动创建目录结构
- 类型清理（删除 CloneWorkspaceRef）
- 单元测试

### Ticket 4: Frontend File Tree Component
- 新建 `CloneFileTree` 组件
- 展开/折叠、选中、只读标记
- 右键菜单
- 组件测试

### Ticket 5: Frontend File Content Panel
- 新建 `CloneFileContent` 组件
- Markdown/JSON 编辑
- 只读模式
- 保存逻辑
- 组件测试

### Ticket 6: Frontend Three-Column Layout
- 新建 `CloneDetailView` 组件
- 整合 FileTree + FileContent + Chat
- 响应式布局（mobile 隐藏 file tree）
- 组件测试

### Ticket 7: Frontend Simplified Creation
- 修改 `CloneCreateWizard` 为 1 步
- 移除技能选择
- 创建后自动进入三栏视图
- E2E 测试

### Ticket 8: Frontend Card + Navigation
- 修改 `CloneCardGrid` 简化显示
- 修改 `CloneTab` 导航到三栏视图
- 移除 `CloneFilePanel`
- 更新 API client
- E2E 测试

## Testing Strategy

### Unit Tests (Vitest)
- Backend: file tree API, file operations, readonly logic
- Frontend: file tree component, file content panel

### Integration Tests
- API 端到端：创建分身 → 列出文件 → 创建目录 → 删除文件
- Readonly 检测：共享技能路径返回 readonly: true

### E2E Tests (Playwright)
- 创建分身流程
- 文件树渲染
- 文件编辑保存
- Chat 交互 + agent 文件操作

## Acceptance Criteria Verification

| AC | Test Method | Status |
|----|-------------|--------|
| 1. 创建分身 → 三栏视图 | Playwright | TODO |
| 2. 文件树显示 | Playwright | TODO |
| 3. 继承资源只读标记 | Playwright | TODO |
| 4. 文件编辑保存 | Playwright | TODO |
| 5. Chat 对话 | Playwright | TODO |
| 6. Agent 管理技能 | Playwright | TODO |
| 7. 卡片精简显示 | Playwright | TODO |
| 8. 交互式创建 | Playwright | TODO |
