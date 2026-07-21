import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { parseManifest, parseManifestJson, writeManifestJson, parseIndexJson, writeIndexJson, buildProjectInfos, findLocalRepo, cloneProject, pullProject, type ManifestEntry, type IndexEntry } from '@octopus/shared'

function getManifestPath(org: string): { jsonPath: string; mdPath: string } {
  const globalDir = process.env.OCTOPUS_HOME ?? path.join(process.env.HOME ?? '~', '.octopus')
  const reposDir = path.join(globalDir, 'orgs', org, 'repos')
  return {
    jsonPath: path.join(reposDir, 'manifest.json'),
    mdPath: path.join(reposDir, 'manifest.md'),
  }
}

function readGroups(org: string): { groups: Record<string, ManifestEntry[]>; source: 'json' | 'md' | 'none' } {
  const { jsonPath, mdPath } = getManifestPath(org)

  if (fs.existsSync(jsonPath)) {
    const content = fs.readFileSync(jsonPath, 'utf-8')
    return { groups: parseManifestJson(content), source: 'json' }
  }
  if (fs.existsSync(mdPath)) {
    const content = fs.readFileSync(mdPath, 'utf-8')
    return { groups: parseManifest(content), source: 'md' }
  }
  return { groups: {}, source: 'none' }
}

function writeGroups(org: string, groups: Record<string, ManifestEntry[]>): void {
  const { jsonPath } = getManifestPath(org)
  const dir = path.dirname(jsonPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // ponytail: atomic write via tmp+rename
  const tmpPath = jsonPath + '.tmp'
  fs.writeFileSync(tmpPath, writeManifestJson(groups), 'utf-8')
  fs.renameSync(tmpPath, jsonPath)
}

function getCloneBase(org: string): string {
  const globalDir = process.env.OCTOPUS_HOME ?? path.join(process.env.HOME ?? '~', '.octopus')
  return path.join(globalDir, 'orgs', org, 'repos', 'projects')
}

function findEntry(groups: Record<string, ManifestEntry[]>, name: string): { entry: ManifestEntry; group: string } | null {
  for (const [group, entries] of Object.entries(groups)) {
    const found = entries.find(e => e.name === name)
    if (found) return { entry: found, group }
  }
  return null
}

const createRepoSchema = z.object({
  name: z.string().min(1, 'name required'),
  git_url: z.string().min(1, 'git_url required'),
  branch: z.string().min(1).default('main'),
  group: z.string().min(1, 'group required'),
  manual_tags: z.array(z.string()).default([]),
  org: z.string().min(1, 'org required'),
})

const updateRepoSchema = z.object({
  git_url: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  manual_tags: z.array(z.string()).optional(),
  org: z.string().min(1, 'org required'),
})

export function createReposRoutes(): Hono {
  const router = new Hono()

  // GET / — read org's manifest and return groups
  router.get('/', (c) => {
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    try {
      const { groups } = readGroups(org)
      return c.json({ groups, org })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'PARSE_ERROR', message: `Failed to parse manifest: ${msg}` } }, 500)
    }
  })

  // POST / — create new repo entry
  router.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    const parsed = createRepoSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.issues },
      }, 400)
    }

    const { name, git_url, branch, group, manual_tags, org } = parsed.data

    const { groups } = readGroups(org)

    // Check duplicate across all groups
    if (findEntry(groups, name)) {
      return c.json({ error: { code: 'DUPLICATE_NAME', message: `Repo '${name}' already exists` } }, 409)
    }

    const entry: ManifestEntry = { name, git_url, branch, manual_tags, group }

    if (!groups[group]) {
      groups[group] = []
    }
    groups[group].push(entry)

    writeGroups(org, groups)

    return c.json({ success: true, entry })
  })

  // PUT /:name — update existing repo entry
  router.put('/:name', async (c) => {
    const name = c.req.param('name')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    const parsed = updateRepoSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.issues },
      }, 400)
    }

    const { org, ...updates } = parsed.data

    const { groups } = readGroups(org)
    const found = findEntry(groups, name)
    if (!found) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Repo '${name}' not found` } }, 404)
    }

    // Handle group change: remove from old group, add to new
    const oldGroup = found.group
    const newGroup = updates.group ?? oldGroup

    // Apply updates to entry
    const updatedEntry: ManifestEntry = {
      ...found.entry,
      ...(updates.git_url !== undefined && { git_url: updates.git_url }),
      ...(updates.branch !== undefined && { branch: updates.branch }),
      ...(updates.manual_tags !== undefined && { manual_tags: updates.manual_tags }),
      group: newGroup,
    }

    // Remove from old group
    groups[oldGroup] = groups[oldGroup].filter(e => e.name !== name)
    if (groups[oldGroup].length === 0) {
      delete groups[oldGroup]
    }

    // Add to new group
    if (!groups[newGroup]) {
      groups[newGroup] = []
    }
    groups[newGroup].push(updatedEntry)

    writeGroups(org, groups)

    return c.json({ success: true, entry: updatedEntry })
  })

  // DELETE /:name — delete repo entry
  router.delete('/:name', (c) => {
    const name = c.req.param('name')
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    const { groups } = readGroups(org)
    const found = findEntry(groups, name)
    if (!found) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Repo '${name}' not found` } }, 404)
    }

    // Remove from group
    groups[found.group] = groups[found.group].filter(e => e.name !== name)
    if (groups[found.group].length === 0) {
      delete groups[found.group]
    }

    writeGroups(org, groups)

    return c.json({ success: true })
  })

  // POST /:name/clone — clone single repo
  router.post('/:name/clone', (c) => {
    const name = c.req.param('name')
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    const { groups } = readGroups(org)
    const found = findEntry(groups, name)
    if (!found) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Repo '${name}' not found` } }, 404)
    }

    if (!found.entry.git_url) {
      return c.json({ error: { code: 'INVALID_URL', message: `Repo '${name}' has no git_url` } }, 400)
    }

    const cloneBase = getCloneBase(org)
    const result = cloneProject(found.entry.git_url, found.entry.group, found.entry.name, found.entry.branch, cloneBase)

    return c.json(result)
  })

  // POST /:name/pull — pull single repo
  router.post('/:name/pull', (c) => {
    const name = c.req.param('name')
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    const { groups } = readGroups(org)
    const found = findEntry(groups, name)
    if (!found) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Repo '${name}' not found` } }, 404)
    }

    const cloneBase = getCloneBase(org)
    const localPath = findLocalRepo(found.entry.group, found.entry.name, cloneBase)
    if (!localPath) {
      return c.json({ success: false, message: `Repo '${name}' not cloned yet` })
    }

    const result = pullProject(localPath, found.entry.branch)
    return c.json(result)
  })

  // POST /pull-all — pull all cloned repos
  router.post('/pull-all', (c) => {
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    const { groups } = readGroups(org)
    const cloneBase = getCloneBase(org)

    let success = 0
    let failed = 0
    const details: Array<{ name: string; success: boolean; message: string }> = []

    for (const [group, entries] of Object.entries(groups)) {
      for (const entry of entries) {
        const localPath = findLocalRepo(group, entry.name, cloneBase)
        if (!localPath) {
          continue
        }
        const result = pullProject(localPath, entry.branch)
        if (result.success) {
          success++
        } else {
          failed++
        }
        details.push({ name: entry.name, success: result.success, message: result.message })
      }
    }

    return c.json({ success, failed, details })
  })

  // POST /clone-missing — clone all uncloned repos
  router.post('/clone-missing', (c) => {
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    const { groups } = readGroups(org)
    const cloneBase = getCloneBase(org)

    let cloned = 0
    let failed = 0
    const details: Array<{ name: string; success: boolean; message: string }> = []

    for (const [group, entries] of Object.entries(groups)) {
      for (const entry of entries) {
        const localPath = findLocalRepo(group, entry.name, cloneBase)
        if (localPath) continue

        if (!entry.git_url) {
          failed++
          details.push({ name: entry.name, success: false, message: 'no git_url' })
          continue
        }

        const result = cloneProject(entry.git_url, group, entry.name, entry.branch, cloneBase)
        if (result.success) {
          cloned++
        } else {
          failed++
        }
        details.push({ name: entry.name, success: result.success, message: result.message })
      }
    }

    return c.json({ cloned, failed, details })
  })

  // POST /rebuild-index — rebuild index.json
  router.post('/rebuild-index', (c) => {
    const org = c.req.query('org')
    if (!org) {
      return c.json({ error: { code: 'MISSING_ORG', message: 'org query parameter required' } }, 400)
    }

    try {
      const { groups } = readGroups(org)
      const cloneBase = getCloneBase(org)

      // Read existing paths from index for fallback
      const { jsonPath: manifestJsonPath } = getManifestPath(org)
      const reposDir = path.dirname(manifestJsonPath)
      const indexPath = path.join(reposDir, 'index.json')

      let existingPaths: Record<string, string> = {}
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8')
        const entries = parseIndexJson(content)
        for (const entry of entries) {
          if (entry.local_path) {
            existingPaths[entry.name] = entry.local_path
          }
        }
      }

      const projectInfos = buildProjectInfos(groups, cloneBase, undefined, true, existingPaths)

      // Convert to IndexEntry[]
      const indexEntries: IndexEntry[] = []
      for (const projects of Object.values(projectInfos)) {
        for (const p of projects) {
          indexEntries.push({
            name: p.name,
            git_url: p.git_url,
            branch: p.branch,
            tags: p.tags,
            tag_source: p.tag_source,
            description: p.description,
            desc_source: p.desc_source,
            local_path: p.local_path,
            knowledge_line: p.knowledge.formatLine(),
          })
        }
      }

      // Write index.json (atomic write)
      const tmpPath = indexPath + '.tmp'
      fs.writeFileSync(tmpPath, writeIndexJson(indexEntries), 'utf-8')
      fs.renameSync(tmpPath, indexPath)

      return c.json({ success: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REBUILD_ERROR', message: `Rebuild failed: ${msg}` } }, 500)
    }
  })

  return router
}
