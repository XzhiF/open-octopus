# Verified Spec: Clone Memory Alignment

## Overview
Extend the main agent memory pipeline to clone agents, enabling clones to record daily memory, auto-archive, refine long-term memory, search with FTS, and apply budget truncation — all while maintaining isolation from main agent memory.

## Goal
Clone agents gain the same memory capabilities as the main agent:
- `record_daily` tool writes to clone's own `memory/daily/` directory
- FTS index includes clone memory with `source` field for filtering
- Archive scheduler scans and archives clone daily files
- Clone long-term memory supports refinement
- System prompt assembly applies budget truncation to clone memory
- Clone memory writes include mtime-based conflict detection

## Architecture

### Data Flow
```
Clone Chat Request
  ↓ (header: X-Clone-Name)
executeMemoryTools()
  ↓ (detect clone context)
MemoryService.recordDaily(cloneDir?, content, sessionId)
  ↓ (write to {cloneDir}/memory/daily/YYYY-MM-DD.md)
  ↓ (insert into messages with source=clone-name)
  ↓ (rebuild FTS with source column)
ArchiveScheduler.run()
  ↓ (scan ~/.octopus/agent/clones/*/memory/daily/)
  ↓ (scan ~/.octopus/agent/built-in/*/memory/daily/)
  ↓ (archive each clone independently)
  ↓ (trigger refineLongTerm for each clone)
GET /memory/search?source=clone-name
  ↓ (filter FTS by source column)
```

### Directory Structure
```
~/.octopus/agent/
├── memory/                          # main agent memory
│   ├── daily/
│   │   ├── 2026-07-28.md
│   │   └── archive/
│   ├── long-term.md
│   └── long-term.md.bak
├── clones/                          # user clones
│   └── {clone-name}/
│       └── memory/
│           ├── daily/
│           │   ├── 2026-07-28.md
│           │   └── archive/
│           ├── long-term.md
│           └── long-term.md.bak
└── built-in/                        # built-in clones
    └── {clone-name}/
        └── memory/
            ├── daily/
            │   ├── 2026-07-28.md
            │   └── archive/
            ├── long-term.md
            └── long-term.md.bak
```

## Technical Design

### 1. FTS Schema Migration
**Table**: `session_memory_fts`
**Change**: Add `source` column (TEXT, default 'main')

```sql
-- Migration: add source column to session_memory_fts
DROP TABLE IF EXISTS session_memory_fts;
CREATE VIRTUAL TABLE session_memory_fts USING fts5(
  session_id,
  summary,
  session_title,
  created_at,
  source  -- NEW: 'main' | clone-name
);
```

**Rationale**: FTS5 virtual tables don't support ALTER TABLE ADD COLUMN. Must rebuild with new schema. Existing data migrates with source='main'.

### 2. MemoryService.recordDaily()
**Signature Change**:
```typescript
recordDaily(
  org: string,
  content: string,
  sessionId: string,
  cloneDir?: string  // NEW: optional clone directory
): { ok: boolean; date: string }
```

**Implementation**:
- If `cloneDir` provided:
  - Write to `{cloneDir}/memory/daily/YYYY-MM-DD.md`
  - Insert message with `source=clone-name` (extract from cloneDir path)
- If `cloneDir` omitted:
  - Write to main agent daily dir (existing behavior)
  - Insert message with `source='main'`

**Path Extraction**:
```typescript
const source = cloneDir
  ? path.basename(cloneDir)  // e.g., 'coder' from ~/.octopus/agent/clones/coder
  : 'main'
```

### 3. executeMemoryTools() Clone Context Detection
**Location**: `packages/server/src/routes/agent/main-agent-route.ts`

**Header**: `X-Clone-Name` (already used for clone chat)

**Change**:
```typescript
async function executeMemoryTools(
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  org: string,
  sessionId: string,
  stream: SSEStreamingApi,
  cloneName?: string  // NEW: from request header
): Promise<void>
```

**Handler Logic**:
```typescript
case 'record_daily': {
  const content = String(input.content ?? '')
  const memoryService = getMemoryService()

  // Determine clone directory if clone context exists
  let cloneDir: string | undefined
  if (cloneName) {
    const cloneDef = resolveCloneDefFromFs(cloneName)
    if (cloneDef) {
      cloneDir = cloneDef.type === 'built-in'
        ? getBuiltInCloneDir(cloneName)
        : getCloneDir(cloneName)
    }
  }

  const result = memoryService.recordDaily(org, content, sessionId, cloneDir)
  resultContent = JSON.stringify(result)
  break
}
```

### 4. ArchiveService.archiveMemoryBatch() Clone Scanning
**Location**: `packages/server/src/services/archive/archive-service.ts`

**Change**: Scan clone directories after main agent daily archive.

**Implementation**:
```typescript
async archiveMemoryBatch(
  org: string,
  config: { session_retention_days: number; long_term_refine_trigger_days: number },
): Promise<{ archived_count: number }> {
  let archivedCount = 0

  // 1. Archive main agent daily files (existing logic)
  // ... existing code ...

  // 2. Scan and archive clone directories (NEW)
  try {
    const { getClonesDir, getBuiltInClonesDir } = await import('../agent/paths')
    const fs = await import('fs')
    const path = await import('path')

    const cloneDirs = [
      getClonesDir(),      // ~/.octopus/agent/clones/
      getBuiltInClonesDir() // ~/.octopus/agent/built-in/
    ]

    for (const baseDir of cloneDirs) {
      if (!fs.existsSync(baseDir)) continue

      const clones = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)

      for (const cloneName of clones) {
        const cloneDailyDir = path.join(baseDir, cloneName, 'memory', 'daily')
        if (!fs.existsSync(cloneDailyDir)) continue

        // Archive clone daily files
        const files = fs.readdirSync(cloneDailyDir).filter(f => f.endsWith('.md'))
        const retentionCutoff = new Date()
        retentionCutoff.setDate(retentionCutoff.getDate() - config.session_retention_days)

        for (const file of files) {
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
          if (!dateMatch) continue
          const fileDate = new Date(dateMatch[1])
          if (fileDate >= retentionCutoff) continue

          try {
            // Archive clone daily file
            const archiveDir = path.join(cloneDailyDir, 'archive')
            if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true })
            fs.renameSync(
              path.join(cloneDailyDir, file),
              path.join(archiveDir, file)
            )
            archivedCount++
            this.emitArchived(`${cloneName}-${dateMatch[1]}`, 'clone_daily_memory', new Date().toISOString())
          } catch (err) {
            logError('failed to archive clone daily memory', err, { org, clone: cloneName, date: dateMatch[1] })
          }
        }

        // Trigger refine for clone long-term memory
        const cloneLtPath = path.join(baseDir, cloneName, 'memory', 'long-term.md')
        if (fs.existsSync(cloneLtPath)) {
          const stat = fs.statSync(cloneLtPath)
          const daysSinceModified = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)
          if (daysSinceModified >= config.long_term_refine_trigger_days) {
            try {
              const memoryService = getMemoryService()
              const cloneDir = path.join(baseDir, cloneName)
              memoryService.refineLongTerm(org, cloneDir)
            } catch (err) {
              logError('clone long-term refine failed', err, { org, clone: cloneName })
            }
          }
        }
      }
    }
  } catch (err) {
    logError('archiveMemoryBatch clone scan failed', err, { org })
  }

  return { archived_count: archivedCount }
}
```

### 5. SystemPromptAssembler.assembleForClone() Restoration
**Location**: `packages/server/src/services/agent/system-prompt-assembler.ts`

**Current State**: Marked as deprecated, delegates to `assemble()`.

**Change**: Implement full priority-based budget truncation for clone context.

**Implementation**:
```typescript
/**
 * Assemble system prompt for a clone with full budget truncation.
 * Restored from deprecated to support clone memory pipeline alignment.
 */
assembleForClone(cloneName: string, options: AssembleOptions = {}): string {
  const cloneDir = this.resolveCloneDir(cloneName)
  if (!cloneDir) {
    // Fallback to main agent assembly if clone not found
    return this.assemble({ ...options, clone_name: cloneName })
  }

  const segments = this.getCloneSegments(cloneName, cloneDir, options)
  const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS

  const truncated = this.truncateToBudget(segments, maxTokens)
  return truncated.map(seg => seg.content).join('\n\n')
}

private getCloneSegments(
  cloneName: string,
  cloneDir: string,
  options: AssembleOptions
): PromptSegment[] {
  const segments: PromptSegment[] = []

  // 1. Clone persona (priority 0 — never dropped)
  segments.push(this.buildClonePersonaSegment(cloneDir, cloneName))

  // 2. Clone long-term memory (priority 1)
  segments.push(this.buildCloneMemorySegment(cloneDir))

  // 3. Clone daily memory (priority 2)
  segments.push(this.buildCloneDailyMemorySegment(cloneDir))

  // 4. Clone skills (priority 3, if applicable)
  if (options.include_skills) {
    segments.push(this.buildCloneSkillsSegment(cloneDir, options.include_skills))
  }

  return segments.sort((a, b) => a.priority - b.priority)
}

private buildClonePersonaSegment(cloneDir: string, cloneName: string): PromptSegment {
  const personaPath = path.join(cloneDir, 'persona.md')
  let content = ''

  if (fs.existsSync(personaPath)) {
    try {
      content = fs.readFileSync(personaPath, 'utf-8')
    } catch {
      content = `# 分身: ${cloneName}\n\n你是 ${cloneName} 分身。`
    }
  } else {
    content = `# 分身: ${cloneName}\n\n你是 ${cloneName} 分身。`
  }

  return {
    name: 'clone_persona',
    content,
    tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
    priority: 0,
    source: 'clone',
  }
}

private buildCloneMemorySegment(cloneDir: string): PromptSegment {
  const ltPath = path.join(cloneDir, 'memory', 'long-term.md')
  let content = ''

  if (fs.existsSync(ltPath)) {
    try {
      const raw = fs.readFileSync(ltPath, 'utf-8')
      content = `# 分身长期记忆\n\n${raw}`
    } catch {
      content = ''
    }
  }

  return {
    name: 'clone_memory',
    content,
    tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
    priority: 1,
    source: 'memory',
  }
}

private buildCloneDailyMemorySegment(cloneDir: string): PromptSegment {
  const dailyDir = path.join(cloneDir, 'memory', 'daily')
  let content = ''

  if (fs.existsSync(dailyDir)) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const todayFile = path.join(dailyDir, `${today}.md`)
      if (fs.existsSync(todayFile)) {
        const raw = fs.readFileSync(todayFile, 'utf-8')
        content = `# 分身工作记忆\n\n${raw}`
      }
    } catch {
      content = ''
    }
  }

  return {
    name: 'clone_daily_memory',
    content,
    tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
    priority: 2,
    source: 'daily_memory',
  }
}

private resolveCloneDir(cloneName: string): string | null {
  // Try built-in first
  const builtInDir = getBuiltInCloneDir(cloneName)
  if (fs.existsSync(builtInDir)) return builtInDir

  // Try user clone
  const userDir = getCloneDir(cloneName)
  if (fs.existsSync(userDir)) return userDir

  return null
}
```

### 6. MemoryService.refineLongTerm() Clone Support
**Signature Change**:
```typescript
refineLongTerm(
  org: string,
  cloneDir?: string  // NEW: optional clone directory
): { refined: boolean; before_tokens: number; after_tokens: number; backup_path: string }
```

**Implementation**:
```typescript
refineLongTerm(org: string, cloneDir?: string) {
  const filePath = cloneDir
    ? path.join(cloneDir, 'memory', 'long-term.md')
    : this.getMemoryPath('long-term')

  if (!fs.existsSync(filePath)) {
    return { refined: false, before_tokens: 0, after_tokens: 0, backup_path: '' }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const beforeTokens = this.estimateTokens(content)

  // Backup before modification
  const backupPath = `${filePath}.bak`
  fs.writeFileSync(backupPath, content, 'utf-8')

  // Parse and refine sections (existing logic)
  const sections = this.parseMarkdownSections(content)
  const refinedSections = sections.map(section => {
    const uniqueLines = this.deduplicateLines(section.lines)
    const maxLines = section.name === '经验教训' ? 20 : 15
    return { ...section, lines: uniqueLines.slice(0, maxLines) }
  })

  const refinedContent = refinedSections
    .map(s => s.lines.length > 0 ? `${s.header}\n${s.lines.join('\n')}` : s.header)
    .join('\n\n')

  fs.writeFileSync(filePath, refinedContent, 'utf-8')
  const afterTokens = this.estimateTokens(refinedContent)

  return { refined: true, before_tokens: beforeTokens, after_tokens: afterTokens, backup_path: backupPath }
}
```

### 7. CloneRuntime.writeIsolatedMemory() Conflict Detection
**Location**: `packages/server/src/services/agent/clone-runtime.ts`

**Signature Change**:
```typescript
writeIsolatedMemory(
  content: string,
  expectedLastModified?: string  // NEW: optional mtime for conflict detection
): void
```

**Implementation**:
```typescript
writeIsolatedMemory(content: string, expectedLastModified?: string): void {
  try {
    const clonePath = this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)
    const memoryDir = path.join(clonePath, 'memory')
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
    }

    const today = new Date().toISOString().slice(0, 10)
    const filePath = path.join(memoryDir, 'daily', `${today}.md`)
    const dailyDir = path.dirname(filePath)
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true })
    }

    // Conflict detection: check if file was modified since client last read it
    if (expectedLastModified && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      const serverModified = stat.mtime.toISOString()
      if (new Date(serverModified).getTime() > new Date(expectedLastModified).getTime()) {
        const err = new Error('Memory was modified by another process. Please reload and try again.') as Error & { code: string }
        err.code = 'MEMORY_CONFLICT'
        throw err
      }
    }

    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const time = new Date().toTimeString().split(' ')[0]
    fs.writeFileSync(filePath, `${existing}\n### ${time}\n${content}\n`, 'utf-8')
  } catch (err) {
    if ((err as { code?: string }).code === 'MEMORY_CONFLICT') {
      throw err  // Re-throw conflict errors
    }
    // Other failures are non-fatal — log only
    console.warn(`[CloneRuntime] Memory write failed for ${this.cloneDef.name}:`, err instanceof Error ? err.message : String(err))
  }
}
```

### 8. GET /memory/search Source Filter
**Location**: `packages/server/src/routes/agent/memory.ts`

**Query Parameter**: `source` (optional)

**Change**:
```typescript
memory.get('/memory/search', (c) => {
  try {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
    if (!org) {
      return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
    }

    const query = c.req.query('q')
    if (!query) {
      return c.json(createAgentError('INVALID_PARAM', 'Query parameter "q" is required'), 400)
    }

    const source = c.req.query('source')  // NEW: optional source filter
    const topK = parseInt(c.req.query('top_k') ?? '3', 10)

    let results: unknown[]
    let degraded = false

    try {
      results = getMemoryService().searchMemory(org, query, topK, source)
    } catch {
      degraded = true
      try {
        getMemoryService().rebuildFtsIndex(org)
        results = getMemoryService().searchMemory(org, query, topK, source)
      } catch {
        results = []
      }
    }

    return c.json({ results, degraded })
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
    return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
  }
})
```

**MemoryService.searchMemory() Change**:
```typescript
searchMemory(
  org: string,
  query: string,
  topK: number = 3,
  source?: string  // NEW: optional source filter
): MemorySearchResult[]
```

**AgentSessionDAO.searchSessionMemory() Change**:
```typescript
searchSessionMemory(
  query: string,
  limit: number = 3,
  source?: string  // NEW: optional source filter
): Array<{
  session_id: string; summary: string; session_title: string; created_at: string; source: string
}> {
  try {
    let sql = `SELECT session_id, summary, session_title, created_at, source FROM session_memory_fts WHERE session_memory_fts MATCH ?`
    const params: unknown[] = [query]

    if (source) {
      sql += ` AND source = ?`
      params.push(source)
    }

    sql += ` ORDER BY rank LIMIT ?`
    params.push(limit)

    return this.stmt(sql).all(...params) as Array<{
      session_id: string; summary: string; session_title: string; created_at: string; source: string
    }>
  } catch {
    // FTS degraded: fallback to LIKE
    let sql = `SELECT session_id, summary, session_title, created_at, source FROM session_memory_fts WHERE summary LIKE ?`
    const params: unknown[] = [`%${query}%`]

    if (source) {
      sql += ` AND source = ?`
      params.push(source)
    }

    sql += ` LIMIT ?`
    params.push(limit)

    return this.stmt(sql).all(...params) as Array<{
      session_id: string; summary: string; session_title: string; created_at: string; source: string
    }>
  }
}
```

## Implementation Order

1. **FTS Schema Migration** — add `source` column, rebuild index
2. **MemoryService.recordDaily()** — accept `cloneDir` param, write to clone path
3. **AgentSessionDAO** — update `searchSessionMemory()` and `rebuildFtsIndex()` for source column
4. **MemoryService.searchMemory()** — accept `source` filter param
5. **executeMemoryTools()** — detect clone context from header, pass clone dir
6. **ArchiveService.archiveMemoryBatch()** — scan clone directories
7. **MemoryService.refineLongTerm()** — accept `cloneDir` param
8. **CloneRuntime.writeIsolatedMemory()** — add mtime conflict detection
9. **SystemPromptAssembler.assembleForClone()** — restore with full budget truncation
10. **GET /memory/search** — add `source` query param

## Testing Strategy

### Unit Tests (Vitest)
1. **MemoryService.recordDaily()** with `cloneDir` param
   - Verify file written to clone daily dir
   - Verify FTS insert with correct source
2. **MemoryService.writeIsolatedMemory()** conflict detection
   - Verify MEMORY_CONFLICT thrown on stale mtime
3. **ArchiveService.archiveMemoryBatch()** clone scanning
   - Verify clone daily files archived
   - Verify clone long-term refine triggered
4. **SystemPromptAssembler.assembleForClone()** budget truncation
   - Verify segments truncated to budget
5. **MemoryService.searchMemory()** source filter
   - Verify results filtered by source

### Integration Tests (curl E2E)
1. Create clone → record_daily → verify file path + FTS source
2. Modify file mtime → trigger archive → verify archive/ exists + refine .bak
3. GET /memory/search → verify source field + filtering
4. writeIsolatedMemory conflict detection → verify MEMORY_CONFLICT

## Acceptance Criteria Mapping

| AC | Implementation | Test |
|----|---------------|------|
| AC1: Clone record_daily | MemoryService.recordDaily(cloneDir) | Unit + E2E |
| AC2: Clone writes to correct path | Path routing logic | Unit |
| AC3: Clone daily auto-archive | ArchiveService.archiveMemoryBatch() | Unit + E2E |
| AC4: Archive triggers clone refine | ArchiveService + refineLongTerm(cloneDir) | Unit + E2E |
| AC5: Clone memory searchable | FTS source column + searchMemory(source) | Unit + E2E |
| AC6: Clone memory budget truncation | assembleForClone() | Unit |
| AC7: Clone write conflict detection | writeIsolatedMemory(expectedLastModified) | Unit |
| AC8: FTS source filtering | searchMemory(source) + DAO | Unit + E2E |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| FTS schema change requires rebuild | Migration script handles rebuild automatically |
| Clone dir path extraction error | Defensive path.basename() with fallback |
| Archive scheduler performance with many clones | Early exit if clone dir doesn't exist |
| assembleForClone() backward compatibility | Keep deprecated fallback for non-migrated callers |

## Glossary

| Term | Definition |
|------|-----------|
| `cloneDir` | Absolute path to clone directory (e.g., `~/.octopus/agent/clones/coder`) |
| `source` | FTS column value: 'main' for main agent, clone-name for clones |
| `clone context` | Request metadata indicating which clone is making the request |
