// packages/server/src/services/agent/__tests__/command-guard.test.ts
//
// The "spec author may not execute" half of the task-author guard.
//
// Gap: the guard only ever scanned Bash for *write targets*, so `git commit`,
// `pnpm test`, and `next dev` all passed through untouched — a task-author
// session could run the whole development loop from the drafting chat. Worse,
// the guard was only installed when `taskHomePath` was truthy
// (routes/clone/index.ts passes undefined when the home is missing on disk),
// so that session ran with no hook at all.
//
// This suite pins three things:
//   1. development-executing commands are denied,
//   2. the legitimate authoring surface still works (octopus validate/simulate,
//      read-only git, curl, read tools),
//   3. the guard still fires with NO task home (the bare-session hole).
//
// It is a DENYLIST, not a sandbox — the "documented holes" block at the bottom
// pins what it deliberately does NOT catch, so the boundary stays honest
// instead of silently assumed.
//
// Seam: buildPathGuard(home?) — the exact hook passed as onBeforeToolCall.
// Pure string logic, NO fs calls.

import { describe, it, expect } from 'vitest'
import path from 'path'
import { buildPathGuard, isTaskAuthorClone } from '../clone-runtime'

const HOME = path.resolve('/Users/runner/.octopus/tasks/t-guardtest')
const guard = buildPathGuard(HOME)
/** The home-less session (task home missing on disk) — this is the hole. */
const bareGuard = buildPathGuard(undefined)

async function denied(cmd: string, g = guard): Promise<boolean> {
  const r = await g('Bash', { command: cmd })
  return r?.allow === false
}

async function allowed(cmd: string, g = guard): Promise<boolean> {
  return (await g('Bash', { command: cmd })) === undefined
}

describe('command guard — development execution is denied', () => {
  const cases = [
    // git: history, index, worktree, publication
    'git add -A',
    'git commit -m "wip"',
    'git commit --amend --no-edit',
    'git push origin main',
    'git checkout -b feat/x',
    'git reset --hard HEAD~1',
    'git rebase main',
    'git stash',
    'git clean -fd',
    'git revert HEAD',
    'git tag v1.0.0',
    'git -C /Users/dev/project commit -m x', // flags before the subcommand
    'git --git-dir=/Users/dev/project/.git commit -m x',
    // package managers: build / test / install / publish
    'pnpm test',
    'pnpm build',
    'pnpm install',
    'pnpm --filter @octopus/server test',
    'pnpm run build',
    'npm ci',
    'npm publish',
    'yarn test',
    'bun install',
    'pip install requests',
    // standalone build runners
    'mvn verify',
    'mvn -q clean install',
    './gradlew build',
    'make all',
    'tsc --noEmit',
    // dev servers
    'next dev',
    'vite build',
    'nodemon server.js',
    'uvicorn app:api',
    // go / cargo
    'go build ./...',
    'go test ./...',
    'cargo test',
    // wrappers must not smuggle a denied program through
    'sudo pnpm test',
    'FOO=1 mvn test',
    'npx next dev',
    // destructive
    'rm -rf /Users/dev/project',
    'rm -fr node_modules',
  ]

  it.each(cases)('denies: %s', async (cmd) => {
    expect(await denied(cmd)).toBe(true)
  })

  it('explains what to do instead of just refusing', async () => {
    const r = await guard('Bash', { command: 'pnpm test' })
    expect(r!.reason).toContain('BLOCKED')
    expect(r!.reason).toContain('pnpm')
    // The escalation path is named, not left to the agent to guess.
    expect(r!.reason).toContain('enqueue')
    expect(r!.reason).toContain('issues/')
  })
})

describe('command guard — the authoring surface still works', () => {
  const cases = [
    // Self-built flows must clear their two hard gates — validate + simulate.
    'octopus workflow validate workflows/my-flow.yaml',
    'octopus workflow simulate workflows/my-flow.yaml',
    'octopus workflow list',
    // Read-only git
    'git status',
    'git diff HEAD',
    'git log --oneline -20',
    'git show HEAD',
    'git branch -a',
    // Ordinary read/inspect work
    'curl -s http://localhost:3001/api/tasks',
    'ls -la .scratch',
    'grep -rn "Key Decisions" .scratch',
    'cat spec.md',
    'find . -name "*.md"',
    'sed -n "1,20p" spec.md',      // read-only sed (no -i)
    'echo "no write target here"',
    'rm scratch-draft.md',          // plain rm is fine; only force flags deny
    'pnpm why left-pad',            // not a build/test/install subcommand
    'git config --get user.name',
  ]

  it.each(cases)('allows: %s', async (cmd) => {
    expect(await allowed(cmd)).toBe(true)
  })
})

describe('command guard — installed even with no task home', () => {
  it('still denies development execution when the home is missing', async () => {
    expect(await denied('pnpm test', bareGuard)).toBe(true)
    expect(await denied('git commit -m x', bareGuard)).toBe(true)
  })

  it('still allows the authoring surface when the home is missing', async () => {
    expect(await allowed('octopus workflow validate x.yaml', bareGuard)).toBe(true)
  })

  it('does not enforce a write scope it has no home for', async () => {
    // Reads are never blocked, and with no home there is no scope to check —
    // the write half stays off rather than guessing a root.
    expect(await bareGuard('Write', { file_path: '/anywhere/x.md' })).toBeUndefined()
  })
})

describe('command guard — scoped to task-author, not every clone', () => {
  it('identifies the task-author clone', () => {
    expect(isTaskAuthorClone({ name: 'task-author' })).toBe(true)
  })

  it('does not claim the other built-ins (workspace must keep its build surface)', () => {
    for (const name of ['workspace', 'scheduler', 'archive', 'resource', 'harness-agent']) {
      expect(isTaskAuthorClone({ name })).toBe(false)
    }
  })
})

describe('command guard — documented holes (denylist, not a sandbox)', () => {
  // These are NOT caught. Pinned so the boundary is explicit: if one of these
  // is ever closed, this block fails and whoever closed it updates the docs.
  const holes = [
    'python -c "open(\'/Users/dev/project/x\',\'w\').write(1)"',
    'node -e "require(\'fs\').writeFileSync(\'/tmp/x\',\'1\')"',
    'cd /Users/dev/project && sh -c "make test"', // basename(dep) is sh, not make
  ]

  it.each(holes)('does not catch: %s', async (cmd) => {
    expect(await allowed(cmd)).toBe(true)
  })
})