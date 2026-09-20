// packages/server/src/services/tasks/__tests__/resolve-v4-phases.test.ts
//
// The v4 ready-gate's phase contract as a PURE function — no DB, no HTTP, no
// home scaffolding beyond a temp dir. resolveV4Phases is exported precisely so
// both callers (enqueue-time gate in TasksService, launch-time re-derivation in
// the task-lifecycle job) share one implementation; that also makes it directly
// testable here.
//
// The suite pins all four checks, and in particular check ④
// (`phase:<i>:no-final-verification`): a batch-consuming flow (matt-spec-dev)
// refuses to enqueue a phase whose issues/ has no final `*-e2e-*` acceptance
// ticket.
//
// Why ④ exists: the writing convention alone was not enough. author-
// verified-requirement says the final acceptance ticket is "always generated",
// but nothing enforced it — the v4 gate never looked at issues/ at all. So a
// batch
// could reach execution with no acceptance ticket, which used to be caught by
// the workflow's integration-gate fallback; that node turned out to be dead
// code under the convention and was deleted. Making the convention a real gate
// is what makes the deletion safe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveV4Phases } from '../task-materialize'
import type { TaskSpec } from '@octopus/shared'

/** Workflow content with no required inputs — keeps ④ the only possible miss. */
const FLOW_NO_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: placeholder
`

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-v4-phases-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

/** Write a spec at `rel` under the temp home (creating parents). */
function writeSpec(rel: string, body = '# spec\n'): void {
  const abs = path.join(home, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

/** Write one ticket into the batch dir that owns `specRel`. */
function writeTicket(specRel: string, filename: string): void {
  const dir = path.join(home, path.dirname(specRel), 'issues')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), '# ticket\n')
}

function phase(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    index: 1,
    name: 'Phase 1',
    slug: 'p1',
    specPath: '.scratch/20260917/p1/spec.md',
    workflowRef: 'built-in/matt-spec-dev',
    inputValues: {},
    ...over,
  }
}

function specWith(phases: unknown[], extra: Record<string, unknown> = {}): TaskSpec {
  return { format: 'v4', phases, ...extra } as unknown as TaskSpec
}

function run(phases: unknown[], refs: Record<string, string> = {}) {
  return resolveV4Phases({
    taskSpec: specWith(phases),
    homeDir: home,
    taskArtifactsDir: path.join(home, 'artifacts'),
    resolveRef: (ref) => (ref in refs ? { content: refs[ref] } : null),
  })
}

const BATCH_FLOW = { 'built-in/matt-spec-dev': FLOW_NO_REQUIRED_INPUTS }
const OTHER_FLOW = { 'built-in/some-other-flow': FLOW_NO_REQUIRED_INPUTS }

describe('resolveV4Phases — ④ final acceptance ticket (batch-consuming flows)', () => {
  it('passes when the batch has a final *-e2e-* ticket', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '01-thing.md')
    writeTicket('.scratch/20260917/p1/spec.md', '02-e2e-acceptance.md')

    const { missing, phases } = run([phase()], BATCH_FLOW)

    expect(missing).toEqual([])
    expect(phases).toHaveLength(1)
  })

  it('misses with the exact key when issues/ has no acceptance ticket', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '01-thing.md')

    const { missing } = run([phase()], BATCH_FLOW)

    expect(missing).toEqual(['phase:1:no-final-verification'])
  })

  it('misses when issues/ does not exist at all', () => {
    writeSpec('.scratch/20260917/p1/spec.md')

    expect(run([phase()], BATCH_FLOW).missing).toEqual(['phase:1:no-final-verification'])
  })

  it('passes (no e2e ticket) when spec declares `Verification Tier: unit-only` (几何重构: 条件化 e2e)', () => {
    writeSpec(
      '.scratch/20260917/p1/spec.md',
      '# spec\n\n## Verification\nVerification Tier: unit-only\n',
    )
    writeTicket('.scratch/20260917/p1/spec.md', '01-thing.md') // functional only, no e2e

    const { missing, phases } = run([phase()], BATCH_FLOW)

    expect(missing).toEqual([])
    expect(phases).toHaveLength(1)
  })

  it('still misses when neither an e2e ticket nor a unit-only tier declaration is present', () => {
    writeSpec('.scratch/20260917/p1/spec.md', '# spec\nVerification Strategy: manual\n')
    writeTicket('.scratch/20260917/p1/spec.md', '01-thing.md')

    expect(run([phase()], BATCH_FLOW).missing).toEqual(['phase:1:no-final-verification'])
  })

  it('accepts the ticket wherever `-e2e-` sits in the name (the flow globs *-e2e-*)', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '05-e2e-verification.md')

    expect(run([phase()], BATCH_FLOW).missing).toEqual([])
  })

  it('matches the flow on the ref basename — bare `matt-spec-dev` counts too', () => {
    writeSpec('.scratch/20260917/p1/spec.md')

    const { missing } = run([phase({ workflowRef: 'matt-spec-dev' })], {
      'matt-spec-dev': FLOW_NO_REQUIRED_INPUTS,
    })

    expect(missing).toEqual(['phase:1:no-final-verification'])
  })

  it('does NOT apply to a flow that does not consume the batch', () => {
    // A self-built flow has its own verification story; demanding an e2e ticket
    // it will never read would be a false positive that blocks legitimate work.
    writeSpec('.scratch/20260917/p1/spec.md')

    const { missing, phases } = run([phase({ workflowRef: 'built-in/some-other-flow' })], OTHER_FLOW)

    expect(missing).toEqual([])
    expect(phases).toHaveLength(1)
  })

  it('is scoped per phase — a clean phase 1 does not excuse a bare phase 2', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '02-e2e-a.md')
    writeSpec('.scratch/20260917/p2/spec.md')
    writeTicket('.scratch/20260917/p2/spec.md', '01-only-this.md')

    const { missing } = run([phase(), phase({ index: 2, slug: 'p2', specPath: '.scratch/20260917/p2/spec.md' })], BATCH_FLOW)

    expect(missing).toEqual(['phase:2:no-final-verification'])
  })

  it('does not double-report when the spec itself is missing (① already covers it)', () => {
    // A missing spec means there is no batch dir to inspect — reporting ④ too
    // would be noise that obscures the real defect.
    const { missing } = run([phase({ specPath: '.scratch/gone/spec.md' })], BATCH_FLOW)

    expect(missing).toEqual(['phase:1:spec-missing'])
  })
})

describe('resolveV4Phases — the pre-existing ①–③ checks still hold', () => {
  it('① missing spec file', () => {
    expect(run([phase()], BATCH_FLOW).missing).toEqual(['phase:1:spec-missing'])
  })

  it('② unresolvable workflow_ref', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    const { missing } = run([phase({ workflowRef: 'unknown/flow' })], BATCH_FLOW)
    expect(missing).toContain('phase:1:workflow-ref')
  })

  it('③ unsatisfied required input', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '02-e2e-a.md')
    const required = `
apiVersion: octopus/v1
kind: Workflow
inputs:
  idea:
    required: true
`
    const { missing } = run([phase({ workflowRef: 'built-in/matt-spec-dev' })], {
      'built-in/matt-spec-dev': required,
    })
    expect(missing).toContain('phase:1:input:idea')
  })

  it('no phases → the single no-phases key', () => {
    expect(run([], BATCH_FLOW).missing).toEqual(['phase:0:no-phases'])
  })

  it('a fully valid batch-consuming phase resolves to a launch config', () => {
    writeSpec('.scratch/20260917/p1/spec.md')
    writeTicket('.scratch/20260917/p1/spec.md', '02-e2e-a.md')

    const { missing, phases } = run([phase()], BATCH_FLOW)

    expect(missing).toEqual([])
    expect(phases[0]).toMatchObject({
      index: 1,
      slug: 'p1',
      specPath: path.join(home, '.scratch/20260917/p1/spec.md'),
      specDir: path.join(home, '.scratch/20260917/p1'),
      workflowRef: 'built-in/matt-spec-dev',
    })
  })
})