// packages/server/src/routes/agent/clone-files.ts
//
// Clone file tree and file operations API.
// Provides recursive directory listing with readonly detection for inherited resources.
//
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import {
  getAgentDir,
  getAgentSkillsDir,
  getBuiltInCloneDir,
  getCloneDir,
} from '../../services/agent/paths'

export interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  readonly: boolean
}

export function createCloneFilesRoutes(): Hono {
  const app = new Hono()

  // GET /clones/:name/files?recursive=true
  app.get('/clones/:name/files', (c) => {
    const name = c.req.param('name')
    const recursive = c.req.query('recursive') === 'true'

    // Determine clone directory (built-in vs user)
    const builtinDir = getBuiltInCloneDir(name)
    const isBuiltin = fs.existsSync(builtinDir)
    const cloneDir = isBuiltin ? builtinDir : getCloneDir(name)

    if (!fs.existsSync(cloneDir)) {
      return c.json({ files: [] })
    }

    const files = scanDirectory(cloneDir, cloneDir, recursive, false)

    // Add inherited resources (shared skills from main agent)
    const agentSkillsDir = getAgentSkillsDir()
    if (fs.existsSync(agentSkillsDir)) {
      const inheritedSkills = scanDirectory(
        agentSkillsDir,
        agentSkillsDir,
        recursive,
        true
      )
      // Prefix paths with __inherited__/skills/ to distinguish from clone files
      inheritedSkills.forEach(f => {
        f.path = `__inherited__/skills/${f.path}`
      })
      files.push(...inheritedSkills)
    }

    return c.json({ files })
  })

  // GET /clones/:name/files/:path — get single file content with readonly flag
  app.get('/clones/:name/files/:path{.+}', (c) => {
    const name = c.req.param('name')
    const filePath = c.req.param('path')

    const targetPath = resolveFilePath(name, filePath)
    if (!targetPath) {
      return c.json({ error: 'File not found' }, 404)
    }

    if (!fs.existsSync(targetPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stats = fs.statSync(targetPath)
    const content = stats.isFile() ? fs.readFileSync(targetPath, 'utf-8') : ''

    return c.json({
      content,
      path: filePath,
      size: stats.size,
      readonly: isReadonlyPath(targetPath),
    })
  })

  // POST /clones/:name/files/:path — create file or directory
  app.post('/clones/:name/files/:path{.+}', async (c) => {
    const name = c.req.param('name')
    const filePath = c.req.param('path')

    let body: { type?: string; content?: string } = {}
    try {
      body = await c.req.json()
    } catch {
      // Empty body is OK for file creation
    }

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
      // Create file (with optional content)
      const dir = path.dirname(targetPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(targetPath, body.content || '', 'utf-8')
    }

    return c.json({ success: true, path: filePath })
  })

  // DELETE /clones/:name/files/:path — delete file or directory
  app.delete('/clones/:name/files/:path{.+}', (c) => {
    const name = c.req.param('name')
    const filePath = c.req.param('path')

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

  return app
}

// ── Helper Functions ─────────────────────────────────────────────

function scanDirectory(
  dir: string,
  baseDir: string,
  recursive: boolean,
  readonly: boolean
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

function getCloneDirectory(name: string): string {
  const builtinDir = getBuiltInCloneDir(name)
  if (fs.existsSync(builtinDir)) return builtinDir
  return getCloneDir(name)
}

function resolveFilePath(name: string, filePath: string): string | null {
  const cloneDir = getCloneDirectory(name)
  const targetPath = path.join(cloneDir, filePath)

  // Path traversal guard
  if (!targetPath.startsWith(cloneDir)) {
    return null
  }

  return targetPath
}

function isReadonlyPath(targetPath: string): boolean {
  const agentDir = getAgentDir()
  const skillsDir = getAgentSkillsDir()
  const memoryDir = path.join(agentDir, 'memory')

  return targetPath.startsWith(skillsDir) || targetPath.startsWith(memoryDir)
}
