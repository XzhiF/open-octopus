// packages/server/src/services/agent/__tests__/path-guard.test.ts
//
// task-phase-redesign ticket 09 (AC2, K17): buildPathGuard Bash write-lock.
//
// Gap (decisions/06 §1): the guard only intercepted Write/Edit/NotebookEdit,
// so `echo x > /anywhere` escaped the draft-session write lock — the task-home
// rules file is advisory and the hook was the ONLY mandatory layer for Bash.
// Now Bash commands are statically scanned for write targets (redirects
// > >> 2> &>, tee, sed -i, dd of=, cp/mv destinations, git --git-dir/--work-tree)
// and any target outside the whitelist — task home + /tmp — is BLOCKED.
// Relative targets resolve against the task home (task-author sessions run
// with cwd = task home, decisions/06 §1). Targets the scanner cannot resolve
// ($HOME, backticks, $(…)) are blocked conservatively — hard-guard posture.
//
// Seam: buildPathGuard(taskHome) — the exact hook passed as onBeforeToolCall
// (clone-runtime.ts sendWithProvider). Pure string logic, NO fs calls, so the
// fake paths below need no fixtures.

import { describe, it, expect } from 'vitest'
import path from 'path'
import { buildPathGuard } from '../clone-runtime'

// Fake home OUTSIDE /tmp so "inside home" cases actually exercise the
// home-prefix branch (not the /tmp whitelist), and /tmp cases exercise theirs.
const HOME = path.resolve('/Users/runner/.octopus/tasks/t-guardtest')
const guard = buildPathGuard(HOME)

async function verdict(toolName: string, input: unknown) {
  return guard(toolName, input)
}

describe('buildPathGuard — Write/Edit regression (unchanged behavior)', () => {
  it('blocks Write outside the task home', async () => {
    const r = await verdict('Write', { file_path: '/Users/dev/project/main.ts' })
    expect(r).toBeDefined()
    expect(r!.allow).toBe(false)
  })

  it('allows Write inside the task home', async () => {
    expect(await verdict('Write', { file_path: path.join(HOME, 'artifacts', 'spec.md') })).toBeUndefined()
  })

  it('read-only tools are always allowed', async () => {
    expect(await verdict('Read', { file_path: '/etc/passwd' })).toBeUndefined()
    expect(await verdict('Glob', { pattern: '/Users/**' })).toBeUndefined()
  })
})

// ── AC2: Bash 参数化案例表 ─────────────────────────────────────────
// [label, command, shouldBlock]
const CASES: Array<[string, string, boolean]> = [
  // --- blocked: plain redirects outside the whitelist
  ['stdout 重定向到 home 外绝对路径', 'echo x > /etc/passwd', true],
  ['append 重定向到 home 外绝对路径', 'echo x >> /Users/dev/outside/notes.md', true],
  ['stderr 重定向也被查', 'make 2> /var/log/build.err', true],
  // --- blocked: write commands
  ['tee 写 home 外', 'cat secret | tee /root/.ssh/authorized_keys', true],
  ['tee 多目标含 home 外', 'echo x | tee artifacts/ok.md /etc/bad', true],
  ['sed -i 原地改 home 外文件', "sed -i 's/a/b/' /Users/dev/project/src/main.ts", true],
  ['dd of= 写 home 外', 'dd if=/dev/zero of=/Users/dev/disk.img bs=1 count=1', true],
  ['cp 目标在 home 外', 'cp notes.md /Users/dev/outside/', true],
  ['mv 目标在 home 外', 'mv artifacts/draft.md /Users/dev/outside/final.md', true],
  ['git --git-dir 指向 home 外仓库', 'git --git-dir=/Users/dev/other/.git commit -m x', true],
  // --- blocked: 绕过变体
  ['引号包裹的绝对路径', 'echo x > "/Users/dev/My Documents/evil.txt"', true],
  ['$HOME 变量目标不可静态解析 → 保守拦', 'echo x > $HOME/.bashrc', true],
  ['"$HOME/…" 引号内变量同样拦', 'echo x >> "$HOME/secret.log"', true],
  ['$(…) 命令替换目标拦', 'echo x > $(echo /Users/dev/f)', true],
  ['sh -c 嵌套重定向被全文扫描抓到', "sh -c 'echo pwned > /Users/dev/.bashrc'", true],
  ['相对路径 .. 逃逸 home', 'echo x > ../../outside/leak.md', true],
  ['重定向无空格紧邻', 'echo x>>/Users/dev/tight.txt', true],
  // --- allowed: task home（含相对路径，cwd=home）
  ['home 内绝对路径', `echo x > ${path.join(HOME, 'artifacts/out.md')}`, false],
  ['相对路径按 task home 解析', 'echo x >> artifacts/notes.md', false],
  ['sed -i 改 home 内文件', "sed -i 's/a/b/' context.md", false],
  ['cp/mv 相对目标留在 home 内', 'mv a.txt b.txt', false],
  // --- allowed: /tmp 白名单（含 macOS realpath /private/tmp）
  ['/tmp 放行', 'echo x > /tmp/probe.txt', false],
  ['/private/tmp 放行', 'sort f.txt > /private/tmp/s.txt', false],
  ['tee 到 /tmp 放行', 'echo x | tee -a /tmp/run.log', false],
  ['/tmp 下 .. 逃逸仍在 /tmp 内', 'echo x > /tmp/a/../b.txt', false],
  // --- allowed: 非路径目标 / 只读命令 / 无写通道
  ['/dev/null 与 fd 复制放行', 'node build.js > /dev/null 2>&1', false],
  ['&>/dev/null 放行', 'pnpm lint &>/dev/null', false],
  ['普通只读命令放行', 'git status && ls -la', false],
  ['grep 文本里含 > 不误伤（相对解析）', 'grep "use > to redirect" README.md', false],
  ['heredoc 写 home 内放行', "cat > artifacts/x.md <<'EOF'\nhi\nEOF", false],
  ['管道无写目标', 'cat spec.md | wc -l', false],
]

describe.each(CASES)('Bash guard: %s', (_label, command, shouldBlock) => {
  it(`${shouldBlock ? 'BLOCKS' : 'ALLOWS'}: ${command.slice(0, 60).replace(/\n/g, '\\n')}`, async () => {
    const r = await verdict('Bash', { command })
    if (shouldBlock) {
      expect(r, `expected BLOCK for: ${command}`).toBeDefined()
      expect(r!.allow).toBe(false)
      expect(r!.reason).toContain('task home')
    } else {
      expect(r, `expected ALLOW for: ${command}`).toBeUndefined()
    }
  })
})

describe('buildPathGuard — Bash edge shapes', () => {
  it('non-string/absent command → allow (nothing to scan)', async () => {
    expect(await verdict('Bash', {})).toBeUndefined()
    expect(await verdict('Bash', { command: 42 })).toBeUndefined()
  })

  it('env-var prefixed command still checked', async () => {
    const r = await verdict('Bash', { command: 'LC_ALL=C cp notes.md /Users/dev/x' })
    expect(r?.allow).toBe(false)
  })
})
