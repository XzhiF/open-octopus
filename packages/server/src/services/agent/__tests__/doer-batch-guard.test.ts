// packages/server/src/services/agent/__tests__/doer-batch-guard.test.ts
//
// 计划回写 票04 (S2): buildDoerBatchGuard — the task-doer REVERSE write fence.
//
// The doer session runs with cwd = execution workspace; {ws}/.scratch/** is the
// isomorphic COPY of the batch dir that seed overwrites home→ws at every round
// start (「会被洗」断层). Plan truth is single-sourced in the task home and the
// ONLY write channel is the 计划回写 REST endpoints (票02/03, S1). This guard
// makes a direct ws-side batch write physically impossible and answers the
// model with a visible reason + the real endpoint shape so it redirects.
//
// Scope discipline (ticket AC): ONLY batch-dir writes are refused. Everything
// else keeps its full surface — projects/ writes, quick-edit commits, Bash
// commands (NO command denylist — unlike the author guard), and ALL reads.
//
// Seam: buildDoerBatchGuard(wsPath, taskId) — the exact hook passed as
// onBeforeToolCall through runChatTurn (chat-turn.ts) for doer turns only.
// Pure path logic, NO fs calls, so fake paths need no fixtures (same posture
// as path-guard.test.ts for the author half).

import { describe, it, expect } from 'vitest'
import path from 'path'
import { buildDoerBatchGuard } from '../clone-runtime'

const WS = path.resolve('/runners/ws-001')
const TASK = 't-pwb04'
const guard = buildDoerBatchGuard(WS, TASK)

const batchSpec = path.join(WS, '.scratch', '20261008', 'p1-mvp', 'spec.md')
const batchIssue = path.join(WS, '.scratch', '20261008', 'p1-mvp', 'issues', '01-feature.md')

async function verdict(toolName: string, input: unknown) {
  return guard(toolName, input)
}

describe('buildDoerBatchGuard — batch-dir writes are refused', () => {
  it('blocks Write/Edit/NotebookEdit into the ws batch dir', async () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      for (const f of [batchSpec, batchIssue]) {
        const r = await verdict(tool, { file_path: f })
        expect(r, `${tool} ${f}`).toBeDefined()
        expect(r!.allow).toBe(false)
      }
    }
  })

  it('blocks notebook_path form and mkdir of a new batch dir', async () => {
    const r1 = await verdict('NotebookEdit', { notebook_path: path.join(WS, '.scratch', 'nb.ipynb') })
    expect(r1?.allow).toBe(false)
    const r2 = await verdict('Bash', { command: `mkdir -p ${path.join('.scratch', '20261010', 'p2-story', 'issues')}` })
    expect(r2?.allow).toBe(false)
  })

  it('blocks Bash write shapes landing in the batch dir (改既有票/建目录/删)', async () => {
    const cmds = [
      'echo 新内容 >> .scratch/20261008/p1-mvp/spec.md',
      'sed -i "s/a/b/" .scratch/20261008/p1-mvp/issues/01-feature.md',
      `tee .scratch/20261008/p1-mvp/fix-report-r2.md`,
      `cp notes.md .scratch/20261008/p1-mvp/spec.md`,
      'mv new-ticket.md .scratch/20261008/p1-mvp/issues/02-next.md',
      `rm ${path.join(WS, '.scratch', '20261008', 'p1-mvp', 'fix-feedback-r1.md')}`,
      "sh -c 'echo pwned > .scratch/20261008/p1-mvp/spec.md'",
      'echo x > $WS/.scratch/a.md',
    ]
    for (const c of cmds) {
      const r = await verdict('Bash', { command: c })
      expect(r, c).toBeDefined()
      expect(r!.allow, c).toBe(false)
    }
  })

  it('blocks the relative batch path under another first segment too (.scratch exact-root match)', async () => {
    const r = await verdict('Write', { file_path: path.join(WS, '.scratch') })
    expect(r?.allow).toBe(false)
  })

  it('reason is model-actionable: REST pointer with the real endpoint shape, no jargon', async () => {
    const r = (await verdict('Write', { file_path: batchSpec }))!
    const reason = r.reason!
    // points at the actual 票02 endpoint, body fields verbatim (planWriteBodySchema)
    expect(reason).toContain(`POST /api/tasks/${TASK}/plan`)
    expect(reason).toContain(`/api/tasks/${TASK}/plan/issues`)
    for (const field of ['batch', 'file', 'content', 'reason', 'source']) {
      expect(reason, `body field ${field}`).toContain(field)
    }
    // gives the WHY in plain terms (one-way mirror, gets overwritten), not internals
    expect(reason).toContain('覆盖')
    expect(reason).not.toContain('S2')
    expect(reason).not.toContain('seam')
  })
})

describe('buildDoerBatchGuard — everything else keeps its full surface', () => {
  it('reads are never blocked, whatever the path', async () => {
    expect(await verdict('Read', { file_path: batchSpec })).toBeUndefined()
    expect(await verdict('Glob', { pattern: path.join(WS, '.scratch', '**') })).toBeUndefined()
    expect(await verdict('Grep', { path: path.join(WS, '.scratch') })).toBeUndefined()
    expect(await verdict('Bash', { command: 'cat .scratch/20261008/p1-mvp/spec.md' })).toBeUndefined()
    expect(await verdict('Bash', { command: 'ls -la .scratch/ && grep -r TODO .scratch/' })).toBeUndefined()
  })

  it('projects/ writes are untouched (快速修改每改即 commit 零变化)', async () => {
    expect(await verdict('Write', { file_path: path.join(WS, 'projects', 'app', 'src', 'x.ts') })).toBeUndefined()
    expect(await verdict('Edit', { file_path: path.join(WS, 'projects', 'app', 'README.md') })).toBeUndefined()
    expect(await verdict('Bash', { command: 'mkdir -p projects/app/dist && echo x > projects/app/out.log' })).toBeUndefined()
    // copy OUT of the batch dir: source may read batch, destination is outside → allow
    expect(await verdict('Bash', { command: 'cp .scratch/20261008/p1-mvp/spec.md projects/app/docs/spec.md' })).toBeUndefined()
  })

  it('no command denylist for the doer — the build surface stays whole', async () => {
    for (const c of ['pnpm test', 'git commit -m x', 'mvn verify', 'next dev', 'pnpm -C projects/app build']) {
      expect(await verdict('Bash', { command: c }), c).toBeUndefined()
    }
  })

  it('writes outside the workspace are this guard not the author fence — allowed here', async () => {
    expect(await verdict('Write', { file_path: path.join('/tmp', 'something.md') })).toBeUndefined()
  })

  it('unresolvable non-batch targets are allowed (no conservative posture for the doer)', async () => {
    expect(await verdict('Bash', { command: 'echo $msg > projects/app/notes.txt' })).toBeUndefined()
    expect(await verdict('Bash', { command: 'cat x > $DST' })).toBeUndefined()
  })
})
