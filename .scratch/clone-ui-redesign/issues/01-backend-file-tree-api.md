# Ticket 01: Backend File Tree API

## Summary
实现分身文件树 API，支持递归列出目录和 readonly 检测。

## Acceptance Criteria
- [ ] `GET /api/clones/:name/files?recursive=true` 返回文件树
- [ ] FileInfo 包含 path, name, type, size, modified, readonly 字段
- [ ] 共享技能路径 (`~/.octopus/agent/skills/*`) 返回 readonly: true
- [ ] 共享记忆路径 (`~/.octopus/agent/memory/*`) 返回 readonly: true
- [ ] 分身专属路径返回 readonly: false
- [ ] 目录不存在时返回空数组（不报错）
- [ ] 单元测试覆盖

## Implementation

### File: `packages/server/src/routes/agent/clone-files.ts` (NEW)

```typescript
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { getAgentDir, getAgentSkillsDir, getBuiltInCloneDir, getCloneDir } from '../../services/agent/paths'

interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  readonly: boolean
}

export function createCloneFilesRoutes(): Hono {
  const app = new Hono()

  // GET /api/clones/:name/files?recursive=true
  app.get('/clones/:name/files', (c) => {
    const name = c.req.param('name')
    const recursive = c.req.query('recursive') === 'true'

    // Determine clone directory
    const isBuiltin = fs.existsSync(path.join(getBuiltInCloneDir(name)))
    const cloneDir = isBuiltin
      ? getBuiltInCloneDir(name)
      : getCloneDir(name)

    if (!fs.existsSync(cloneDir)) {
      return c.json({ files: [] })
    }

    const files = scanDirectory(cloneDir, cloneDir, recursive)

    // Add inherited resources (shared skills + memory)
    const agentSkillsDir = getAgentSkillsDir()
    if (fs.existsSync(agentSkillsDir)) {
      const inheritedSkills = scanDirectory(agentSkillsDir, agentSkillsDir, recursive, true)
      inheritedSkills.forEach(f => {
        f.path = `__inherited__/skills/${f.path}`
      })
      files.push(...inheritedSkills)
    }

    return c.json({ files })
  })

  return app
}

function scanDirectory(
  dir: string,
  baseDir: string,
  recursive: boolean,
  readonly: boolean = false
): FileInfo[] {
  const results: FileInfo[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(baseDir, fullPath)

      try {
        const stats = fs.statSync(fullPath)
        const info: FileInfo = {
          path: relativePath,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isDirectory() ? 0 : stats.size,
          modified: stats.mtime.toISOString(),
          readonly,
        }

        results.push(info)

        if (recursive && entry.isDirectory()) {
          const children = scanDirectory(fullPath, baseDir, recursive, readonly)
          results.push(...children)
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Directory read failure is non-fatal
  }

  return results
}
```

### Register Route
在 `packages/server/src/index.ts` 中注册：

```typescript
import { createCloneFilesRoutes } from './routes/agent/clone-files'

// ...
app.route('/api', createCloneFilesRoutes())
```

### Tests: `packages/server/src/__tests__/clone-files.test.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Clone Files API', () => {
  const testDir = path.join(os.tmpdir(), 'octopus-test-clone-files')

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
    fs.mkdirSync(path.join(testDir, 'skills', 'test-skill'), { recursive: true })
    fs.writeFileSync(path.join(testDir, 'persona.md'), '# Test Persona')
    fs.writeFileSync(path.join(testDir, 'skills', 'test-skill', 'SKILL.md'), '# Test Skill')
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('scans directory recursively', () => {
    // Test scanDirectory function
    const results = scanDirectory(testDir, testDir, true)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(f => f.name === 'persona.md')).toBe(true)
    expect(results.some(f => f.name === 'test-skill')).toBe(true)
    expect(results.some(f => f.name === 'SKILL.md')).toBe(true)
  })

  it('marks readonly correctly', () => {
    const results = scanDirectory(testDir, testDir, true, true)
    expect(results.every(f => f.readonly === true)).toBe(true)
  })
})
```

## Verification
```bash
# Run tests
pnpm test packages/server/src/__tests__/clone-files.test.ts

# Manual test
curl http://localhost:3001/api/clones/workspace/files?recursive=true | jq
```
