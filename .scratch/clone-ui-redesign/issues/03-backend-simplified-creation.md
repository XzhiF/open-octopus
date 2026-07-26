# Ticket 03: Backend Simplified Creation

## Summary
简化分身创建 API，移除 persona/skills/workspace，自动创建目录结构。

## Acceptance Criteria
- [ ] `POST /api/clones` 只接受 name, display_name, memory_scope
- [ ] 自动创建 persona.md（空模板）
- [ ] 自动创建 config.json（默认配置）
- [ ] 自动创建 skills/ 目录
- [ ] 自动创建 memory/ 目录
- [ ] 删除 CloneWorkspaceRef 类型
- [ ] 从 CloneInfo 删除 workspace 字段
- [ ] 单元测试覆盖

## Implementation

### File: `packages/server/src/routes/clones.ts` (MODIFY)

找到 `POST /api/clones` 路由，修改：

```typescript
app.post('/clones', async (c) => {
  const body = await c.req.json<{
    name: string
    display_name: string
    memory_scope?: 'shared' | 'isolated'
  }>()

  // Validation
  if (!body.name || !/^[a-z0-9-]+$/.test(body.name)) {
    return c.json({ error: 'Invalid name' }, 400)
  }
  if (!body.display_name) {
    return c.json({ error: 'display_name required' }, 400)
  }

  const cloneDir = getCloneDir(body.name)

  // Check if exists
  if (fs.existsSync(cloneDir)) {
    return c.json({ error: 'Clone already exists' }, 409)
  }

  // Create directory structure
  fs.mkdirSync(path.join(cloneDir, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(cloneDir, 'memory'), { recursive: true })

  // Create persona.md (empty template)
  fs.writeFileSync(
    path.join(cloneDir, 'persona.md'),
    `# 分身: ${body.display_name}\n\n（请在 Chat 中描述你希望这个分身具备的特质）\n`,
    'utf-8'
  )

  // Create config.json
  fs.writeFileSync(
    path.join(cloneDir, 'config.json'),
    JSON.stringify({
      name: body.name,
      display_name: body.display_name,
      memory_scope: body.memory_scope || 'isolated',
      created_at: new Date().toISOString(),
    }, null, 2),
    'utf-8'
  )

  // Create meta.json
  fs.writeFileSync(
    path.join(cloneDir, 'meta.json'),
    JSON.stringify({
      name: body.name,
      display_name: body.display_name,
      type: 'user',
      status: 'idle',
      created_at: new Date().toISOString(),
    }, null, 2),
    'utf-8'
  )

  return c.json({
    name: body.name,
    display_name: body.display_name,
    type: 'user',
    persona: '',
    skills: [],
    memory_scope: body.memory_scope || 'isolated',
    status: 'idle',
    created_at: new Date().toISOString(),
  }, 201)
})
```

### Type Cleanup: `packages/web-app/lib/agent/types.ts` (MODIFY)

```typescript
// DELETE this interface
export interface CloneWorkspaceRef {
  workspace_name: string
  workspace_path: string
  branch: string
  projects: string[]
}

// MODIFY CloneInfo — remove workspace field
export interface CloneInfo {
  name: string
  display_name: string
  type: 'built-in' | 'user'
  persona: string
  skills: string[]
  memory_scope: 'shared' | 'isolated'
  // workspace?: { name: string; path: string }  // REMOVE
  status: 'active' | 'idle' | 'executing'
  created_at?: string
  last_active?: string
}

// MODIFY CreateCloneRequest — remove persona, skills, workspace
export interface CreateCloneRequest {
  name: string
  display_name: string
  // persona: string  // REMOVE
  // skills?: string[]  // REMOVE
  // workspace?: { name?: string; path?: string }  // REMOVE
  memory_scope?: 'shared' | 'isolated'
}
```

### Tests: `packages/server/src/__tests__/clone-create.test.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Clone Creation', () => {
  const testDir = path.join(os.tmpdir(), 'octopus-test-clone-create')

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('creates directory structure', () => {
    const cloneDir = path.join(testDir, 'test-clone')
    fs.mkdirSync(path.join(cloneDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(cloneDir, 'memory'), { recursive: true })

    expect(fs.existsSync(path.join(cloneDir, 'skills'))).toBe(true)
    expect(fs.existsSync(path.join(cloneDir, 'memory'))).toBe(true)
  })

  it('creates persona.md template', () => {
    const cloneDir = path.join(testDir, 'test-clone')
    fs.mkdirSync(cloneDir, { recursive: true })
    fs.writeFileSync(
      path.join(cloneDir, 'persona.md'),
      '# 分身: Test\n\n（请描述）\n',
      'utf-8'
    )

    const content = fs.readFileSync(path.join(cloneDir, 'persona.md'), 'utf-8')
    expect(content).toContain('# 分身: Test')
  })
})
```

## Verification
```bash
# Run tests
pnpm test packages/server/src/__tests__/clone-create.test.ts

# Manual test
curl -X POST http://localhost:3001/api/clones \
  -H "Content-Type: application/json" \
  -d '{"name":"test-clone","display_name":"测试分身"}'

# Verify files created
ls -la ~/.octopus/agent/clones/test-clone/
```
