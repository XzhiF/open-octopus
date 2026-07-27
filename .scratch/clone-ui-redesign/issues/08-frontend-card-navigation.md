# Ticket 08: Frontend Card + Navigation

## Summary
简化分身卡片显示，修改导航到三栏视图，更新 API client。

## Acceptance Criteria
- [ ] CloneCardGrid 移除技能数量徽章
- [ ] CloneCardGrid 移除 persona 预览
- [ ] CloneCardGrid 添加最后活跃时间
- [ ] CloneTab 导航到 CloneDetailView（替换 CloneChatView）
- [ ] 移除 CloneFilePanel（侧滑面板）
- [ ] API client 新增 listCloneFiles, createCloneDirectory, deleteCloneFile
- [ ] API client 修改 createClone 移除 persona/skills/workspace
- [ ] E2E 测试覆盖

## Implementation

### File: `packages/web-app/components/agent/clone/CloneCardGrid.tsx` (MODIFY)

简化卡片显示：

```typescript
// Remove skills count badge:
// <span>{clone.skills.length} 技能</span>

// Remove persona preview:
// <p className="text-sm text-muted-foreground line-clamp-2">{clone.persona}</p>

// Add last active time:
import { formatDistanceToNow } from 'date-fns'

// In card render:
{clone.last_active && (
  <span className="text-xs text-muted-foreground">
    {formatDistanceToNow(new Date(clone.last_active), { addSuffix: true })}
  </span>
)}
```

### File: `packages/web-app/components/agent/clone/CloneTab.tsx` (MODIFY)

替换导航目标：

```typescript
// Change this:
import { CloneChatView } from './CloneChatView'
// ...
if (activeChatClone) {
  return <CloneChatView clone={activeChatClone} onBack={() => setActiveChatClone(null)} />
}

// To this:
import { CloneDetailView } from './CloneDetailView'
// ...
if (activeChatClone) {
  return <CloneDetailView clone={activeChatClone} onBack={() => setActiveChatClone(null)} />
}

// Remove CloneFilePanel:
// import { CloneFilePanel } from './CloneFilePanel'
// <CloneFilePanel clone={fileMgmtClone} onClose={() => setFileMgmtClone(null)} />

// Remove onManageFiles prop from CloneCardGrid (no longer needed)
```

### File: `packages/web-app/lib/agent/api.ts` (MODIFY)

新增和修改 API 方法：

```typescript
// Add new methods:
async listCloneFiles(name: string, recursive?: boolean): Promise<{ files: FileInfo[] }> {
  const url = `/api/clones/${name}/files${recursive ? '?recursive=true' : ''}`
  const res = await fetch(this.baseUrl + url, {
    headers: { Authorization: 'Bearer agent' },
  })
  if (!res.ok) throw new Error('Failed to list files')
  return res.json()
}

async createCloneDirectory(name: string, path: string): Promise<{ success: boolean }> {
  const res = await fetch(this.baseUrl + `/api/clones/${name}/files/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer agent',
    },
    body: JSON.stringify({ type: 'directory' }),
  })
  if (!res.ok) throw new Error('Failed to create directory')
  return res.json()
}

async deleteCloneFile(name: string, path: string): Promise<{ success: boolean }> {
  const res = await fetch(this.baseUrl + `/api/clones/${name}/files/${path}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer agent' },
  })
  if (!res.ok) throw new Error('Failed to delete file')
  return res.json()
}

// Modify createClone:
async createClone(req: {
  name: string
  display_name: string
  memory_scope?: 'shared' | 'isolated'
}): Promise<CloneInfo> {
  const res = await fetch(this.baseUrl + '/api/clones', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer agent',
    },
    body: JSON.stringify(req),  // No longer includes persona, skills, workspace
  })
  if (!res.ok) throw new Error('Failed to create clone')
  return res.json()
}

// Modify getCloneFile to include readonly:
async getCloneFile(name: string, path: string): Promise<{
  content: string
  path: string
  size: number
  readonly: boolean  // NEW
}> {
  const res = await fetch(this.baseUrl + `/api/clones/${name}/files/${path}`, {
    headers: { Authorization: 'Bearer agent' },
  })
  if (!res.ok) throw new Error('Failed to get file')
  return res.json()
}
```

### File: `packages/web-app/lib/agent/types.ts` (MODIFY)

添加 FileInfo 类型：

```typescript
export interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  readonly: boolean
}
```

### Delete: `packages/web-app/components/agent/clone/CloneFilePanel.tsx`

删除此文件（不再需要侧滑面板）。

### E2E Test: `packages/web-app/e2e/clone-card.spec.ts` (NEW)

```typescript
import { test, expect } from '@playwright/test'

test.describe('Clone Card Display', () => {
  test('shows simplified card info', async ({ page }) => {
    await page.goto('/agent?tab=clone')

    // Verify: no skills count badge
    const card = page.locator('.clone-card').first()
    await expect(card.locator('text=技能')).not.toBeVisible()

    // Verify: shows memory scope badge
    await expect(card.locator('text=/共享记忆|独立记忆/')).toBeVisible()

    // Verify: shows last active time (if available)
    // Note: may not be visible for newly created clones
  })

  test('navigates to three-column view on click', async ({ page }) => {
    await page.goto('/agent?tab=clone')

    // Click first clone card
    await page.locator('.clone-card').first().click()

    // Verify: enters three-column view
    await expect(page.locator('[class*="FileTree"], .file-tree')).toBeVisible()
    await expect(page.locator('[class*="ChatArea"]')).toBeVisible()
  })
})
```

## Verification
```bash
# Run E2E tests
pnpm exec playwright test e2e/clone-card.spec.ts

# Manual test: verify card display, click navigation, file tree visibility
```
