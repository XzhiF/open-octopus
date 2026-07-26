# Ticket 07: Frontend Simplified Creation

## Summary
简化创建向导为 1 步，创建后自动进入三栏视图。

## Acceptance Criteria
- [ ] CloneCreateWizard 只有 1 步（name + display_name）
- [ ] 移除技能选择
- [ ] memory_scope 默认 'isolated'，不显示
- [ ] 创建成功后自动进入三栏视图
- [ ] Chat 中 agent 主动问 "你想让我成为什么样的分身？"
- [ ] E2E 测试覆盖

## Implementation

### File: `packages/web-app/components/agent/clone/CloneCreateWizard.tsx` (MODIFY)

简化为 1 步：

```typescript
'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/agent/api'

interface CloneCreateWizardProps {
  onClose: () => void
  onCreated: (cloneName: string) => void
}

export function CloneCreateWizard({ onClose, onCreated }: CloneCreateWizardProps) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    if (!name || !displayName) {
      setError('请填写所有字段')
      return
    }

    if (!/^[a-z0-9-]+$/.test(name)) {
      setError('英文代号只能包含小写字母、数字和连字符')
      return
    }

    setCreating(true)
    setError('')

    try {
      await api.createClone({
        name,
        display_name: displayName,
        memory_scope: 'isolated',
      })
      onCreated(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-agent-surface-raised rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium">创建分身</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-agent-error-light text-agent-error text-sm rounded">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">英文代号</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="w-full px-3 py-2 bg-agent-surface border border-agent-divider rounded focus:outline-none focus:ring-1 focus:ring-agent-primary"
              placeholder="my-clone"
              maxLength={50}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              小写字母、数字和连字符，1-50 字符
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">显示名称</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-agent-surface border border-agent-divider rounded focus:outline-none focus:ring-1 focus:ring-agent-primary"
              placeholder="我的分身"
              maxLength={64}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              支持中文，在 UI 中显示
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !name || !displayName}
          >
            {creating ? '创建中...' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}
```

### File: `packages/web-app/components/agent/clone/CloneTab.tsx` (MODIFY)

修改 `onCreated` 回调，自动进入三栏视图：

```typescript
// Change this:
<CloneCreateWizard
  onClose={() => setShowWizard(false)}
  onCreated={() => { setShowWizard(false); refetch() }}
/>

// To this:
<CloneCreateWizard
  onClose={() => setShowWizard(false)}
  onCreated={async (cloneName: string) => {
    setShowWizard(false)
    await refetch()
    // Find the newly created clone and enter its detail view
    const newClone = clones.find(c => c.name === cloneName)
    if (newClone) {
      setActiveChatClone(newClone)
    }
  }}
/>
```

### File: `packages/web-app/components/agent/clone/CloneChatView.tsx` (MODIFY)

在 Chat 中自动发送引导消息：

```typescript
// In useEffect, after session is created/selected:
useEffect(() => {
  if (activeSession && messages.length === 0) {
    // Auto-send guiding message
    setTimeout(() => {
      sendMessage('你好！我是你的新分身。你想让我成为什么样的分身？描述一下我的性格、专长和工作方式。')
    }, 500)
  }
}, [activeSession, messages.length])
```

### E2E Test: `packages/web-app/e2e/clone-creation.spec.ts` (NEW)

```typescript
import { test, expect } from '@playwright/test'

test.describe('Clone Creation', () => {
  const testCloneName = `e2e-test-${Date.now()}`

  test.afterAll(async ({ page }) => {
    // Cleanup: delete test clone
    await page.goto('/agent?tab=clone')
    // ... delete logic
  })

  test('creates clone and enters three-column view', async ({ page }) => {
    await page.goto('/agent?tab=clone')

    // Click create button
    await page.click('button:has-text("创建分身")')

    // Fill form
    await page.fill('input[placeholder="my-clone"]', testCloneName)
    await page.fill('input[placeholder="我的分身"]', 'E2E 测试分身')

    // Submit
    await page.click('button:has-text("创建")')

    // Verify: enters three-column view
    await expect(page.locator('.file-tree, [class*="FileTree"]')).toBeVisible()
    await expect(page.locator('[class*="ChatArea"]')).toBeVisible()

    // Verify: agent sends guiding message
    await expect(page.locator('text=你想让我成为什么样的分身')).toBeVisible({ timeout: 10000 })
  })
})
```

## Verification
```bash
# Run E2E tests
pnpm exec playwright test e2e/clone-creation.spec.ts

# Manual test: create clone, verify auto-navigation and guiding message
```
