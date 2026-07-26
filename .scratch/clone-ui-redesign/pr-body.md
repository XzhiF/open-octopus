# Clone UI Redesign - File System First + Agent-First Model

## 📋 Overview

重新设计分身管理 UI，采用文件系统为核心的 Agent-first 模型，提供 IDE 风格的三栏布局（文件树 | 文件内容 | Chat）。

## 🎯 Key Changes

### Backend (packages/server)
- ✅ **File Tree API**: `GET /api/clones/:name/files?recursive=true` with readonly detection
- ✅ **File Operations**: `POST/DELETE /api/clones/:name/files/:path` for nested file management
- ✅ **Simplified Creation**: `POST /api/clones` now only requires `name` + `display_name`
- ✅ **Auto-directory Structure**: Creates `skills/`, `memory/`, `persona.md` automatically
- ✅ **Readonly Detection**: Shared skills/memory marked as readonly in API responses

### Frontend (packages/web-app)
- ✅ **Three-Column Layout**: `CloneDetailView` with file tree | file content | chat panels
- ✅ **File Tree Component**: VS Code-style tree with expand/collapse, readonly markers, context menu
- ✅ **File Content Panel**: Markdown preview, JSON editing, readonly mode, save functionality
- ✅ **Simplified Creation Wizard**: 1-step form (name + display_name + memory_scope)
- ✅ **Updated Card Display**: Shows `last_active` relative time, memory scope badge
- ✅ **Navigation Update**: Click clone card → enters three-column detail view

## 🏗️ Architecture Decisions

| Decision | Conclusion | Reason |
|----------|-----------|--------|
| UI Model | File system browser | User chose: clone design should be file-system first |
| Layout | Three-column (file tree \| content \| chat) | Consistent with workspace page, IDE-style |
| Skill Management | Agent-first | Agent manages skills/ directory in chat |
| Memory Management | Agent-first | Agent reads/writes memory/ files in chat |
| Resource Library | Optional skill | Not mandatory binding, query via octo-resource-manager |
| Project Association | Deleted | User deemed unnecessary |
| Inherited Resources | Readonly markers | Shared skills/memory shown as "Inherited from Main Agent (readonly)" |
| Creation Flow | Interactive | Minimal form → enter view → agent guides persona setup |

## 🧪 E2E Verification Results

| AC | Test | Status |
|----|------|--------|
| 1 | 创建分身 → 进入三栏视图 | ✅ PASS |
| 2 | 文件树显示 persona.md, config.json, skills/, memory/ | ✅ PASS |
| 3 | 继承资源区块显示 "继承自 Main Agent（只读）" | ✅ PASS |
| 4 | 点 persona.md → 编辑 → 保存成功 | ✅ PASS |
| 5 | Chat 面板可正常对话 | ✅ PASS |
| 6 | Agent 在 chat 中创建 skills/my-skill/SKILL.md | ✅ PASS |
| 7 | 分身卡片显示 name, display_name, status, memory_scope, last_active | ✅ PASS |
| 8 | 创建向导为 1 步（简化） | ✅ PASS |

**Test Evidence**: 54 screenshots in `.scratch/clone-ui-redesign/e2e-screenshots/`

## 📦 Commits

1. `768ad2c` - feat(backend): clone file tree API + simplified creation
2. `8be06ee` - feat(frontend): three-column clone detail view + simplified creation
3. `fd213b7` - fix: E2E verification failures (5 critical bugs)

## 🚀 Testing Instructions

### Manual Testing
1. Start dev server: `pnpm dev`
2. Navigate to `/agent?tab=clone`
3. Click "创建分身" → fill name + display_name → 创建
4. Verify: enters three-column view (file tree | content | chat)
5. Verify: file tree shows persona.md, config.json, skills/, memory/
6. Verify: "继承自 Main Agent（只读）" section at bottom
7. Click persona.md → edit content → save
8. Send chat message → verify agent responds
9. Ask agent to create a skill → verify file tree updates

### Automated Testing
```bash
# Backend unit tests
pnpm test packages/server/src/__tests__/clone-files.test.ts

# E2E tests (Playwright)
cd .scratch/clone-ui-redesign/e2e-scripts
node clone-ui-redesign-e2e.mjs
```

## 🔗 Related

- **Brief**: `.scratch/clone-ui-redesign/brief.md`
- **Spec**: `.scratch/clone-ui-redesign/spec.md`
- **E2E Scripts**: `.scratch/clone-ui-redesign/e2e-scripts/`
- **E2E Screenshots**: `.scratch/clone-ui-redesign/e2e-screenshots/`

## ⚠️ Breaking Changes

- `POST /api/clones` no longer accepts `persona`, `skills`, `workspace` fields
- `CloneWorkspaceRef` type removed from `packages/web-app/lib/agent/types.ts`
- `CloneInfo.workspace` field removed

## 🔄 Migration Notes

No database migration required. All changes are filesystem-based and API-level.

Existing clones will continue to work. New clones will have:
- Empty `persona.md` (agent fills via chat)
- Empty `skills/` directory (agent manages via chat)
- Empty `memory/` directory (agent manages via chat)
