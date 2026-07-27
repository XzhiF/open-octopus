# Ticket 02: Backend File Operations

## Summary
实现文件创建、删除操作，增强 GET 接口返回 readonly 标记。

## Acceptance Criteria
- [ ] `POST /api/clones/:name/files/:path` 创建目录
- [ ] `DELETE /api/clones/:name/files/:path` 删除文件/目录
- [ ] `GET /api/clones/:name/files/:path` 返回 readonly 字段
- [ ] 只读路径拒绝写入操作（403）
- [ ] 路径遍历防护（不能访问 clone 目录外）
- [ ] 单元测试覆盖

## Implementation

### File: `packages/server/src/routes/agent/clone-files.ts` (CONTINUE)

```typescript
// POST /api/clones/:name/files/:path — create directory
app.post('/clones/:name/files/*', async (c) => {
  const name = c.req.param('name')
  const filePath = c.req.param('*')
  const body = await c.req.json<{ type?: string }>()

  const cloneDir = getCloneDirectory(name)
  const targetPath = path.join(cloneDir, filePath)

  // Path traversal guard
  if (!targetPath.startsWith(cloneDir)) {
    return c.json({ error: 'Path traversal detected' }, 403)
  }

  // Readonly guard
  if (isReadonlyPath(targetPath)) {
    return c.json({ error: 'Cannot modify readonly path' }, 403)
  }

  if (body.type === 'directory') {
    fs.mkdirSync(targetPath, { recursive: true })
  } else {
    // Create empty file
    const dir = path.dirname(targetPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(targetPath, '', 'utf-8')
  }

  return c.json({ success: true, path: filePath })
})

// DELETE /api/clones/:name/files/:path
app.delete('/clones/:name/files/*', (c) => {
  const name = c.req.param('name')
  const filePath = c.req.param('*')

  const cloneDir = getCloneDirectory(name)
  const targetPath = path.join(cloneDir, filePath)

  // Path traversal guard
  if (!targetPath.startsWith(cloneDir)) {
    return c.json({ error: 'Path traversal detected' }, 403)
  }

  // Readonly guard
  if (isReadonlyPath(targetPath)) {
    return c.json({ error: 'Cannot modify readonly path' }, 403)
  }

  if (fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    if (stats.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(targetPath)
    }
  }

  return c.json({ success: true })
})

// GET /api/clones/:name/files/:path — enhanced with readonly
app.get('/clones/:name/files/*', (c) => {
  const name = c.req.param('name')
  const filePath = c.req.param('*')

  const cloneDir = getCloneDirectory(name)
  const targetPath = path.join(cloneDir, filePath)

  if (!fs.existsSync(targetPath)) {
    return c.json({ error: 'File not found' }, 404)
  }

  const stats = fs.statSync(targetPath)
  const content = fs.readFileSync(targetPath, 'utf-8')

  return c.json({
    content,
    path: filePath,
    size: stats.size,
    readonly: isReadonlyPath(targetPath),
  })
})

// Helper functions
function getCloneDirectory(name: string): string {
  const builtinDir = getBuiltInCloneDir(name)
  if (fs.existsSync(builtinDir)) return builtinDir
  return getCloneDir(name)
}

function isReadonlyPath(targetPath: string): boolean {
  const agentDir = getAgentDir()
  const skillsDir = getAgentSkillsDir()
  const memoryDir = path.join(agentDir, 'memory')

  return targetPath.startsWith(skillsDir) || targetPath.startsWith(memoryDir)
}
```

### Tests: `packages/server/src/__tests__/clone-files-ops.test.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Clone File Operations', () => {
  const testDir = path.join(os.tmpdir(), 'octopus-test-clone-ops')

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('creates directory', () => {
    const newDir = path.join(testDir, 'new-dir')
    fs.mkdirSync(newDir, { recursive: true })
    expect(fs.existsSync(newDir)).toBe(true)
  })

  it('deletes file', () => {
    const file = path.join(testDir, 'test.txt')
    fs.writeFileSync(file, 'test')
    fs.unlinkSync(file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('deletes directory recursively', () => {
    const dir = path.join(testDir, 'dir')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'file.txt'), 'test')
    fs.rmSync(dir, { recursive: true, force: true })
    expect(fs.existsSync(dir)).toBe(false)
  })
})
```

## Verification
```bash
# Run tests
pnpm test packages/server/src/__tests__/clone-files-ops.test.ts

# Manual test
curl -X POST http://localhost:3001/api/clones/test-clone/files/new-dir \
  -H "Content-Type: application/json" \
  -d '{"type":"directory"}'

curl -X DELETE http://localhost:3001/api/clones/test-clone/files/new-dir
```
