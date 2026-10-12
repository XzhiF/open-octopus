import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ResourcePreFlight } from '../resource-preflight'
import { ResourceProvisioner } from '../resource-provisioner'
import { ResourceManager } from '@octopus/shared'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'))
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

describe('ResourcePreFlight', () => {
  let tmpDir: string
  let preflight: ResourcePreFlight

  beforeEach(() => {
    tmpDir = createTempDir()
    preflight = new ResourcePreFlight()
  })

  afterEach(() => {
    cleanupDir(tmpDir)
  })

  describe('analyze', () => {
    it('extracts agent_file from agent nodes', () => {
      const workflow = {
        nodes: [
          { type: 'agent', agent_file: 'agents/software-architect.md' },
          { type: 'agent', agent_file: '~/.claude/agents/code-reviewer.md' },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('software-architect')
      expect(manifest.agents).toContain('code-reviewer')
      expect(manifest.agents.length).toBe(2)
    })

    it('extracts agent_file from swarm experts', () => {
      const workflow = {
        nodes: [
          {
            type: 'swarm',
            experts: [
              { agent_file: 'agents/expert-a.md' },
              { agent_file: 'agents/expert-b.md' },
            ],
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('expert-a')
      expect(manifest.agents).toContain('expert-b')
    })

    it('extracts skills from all node types', () => {
      const workflow = {
        nodes: [
          { type: 'agent', skills: ['brainstorming', 'tdd-workflow'] },
          { type: 'bash', skills: ['chinese-code-review'] },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('brainstorming')
      expect(manifest.skills).toContain('tdd-workflow')
      expect(manifest.skills).toContain('chinese-code-review')
    })

    it('skips variable references in agent_file', () => {
      const workflow = {
        nodes: [
          { type: 'agent', agent_file: '$vars.agent_path' },
          { type: 'agent', agent_file: 'agents/real-agent.md' },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('real-agent')
      expect(manifest.agents.length).toBe(1)
    })

    it('skips variable references in skills', () => {
      const workflow = {
        nodes: [
          { type: 'agent', skills: ['$vars.dynamic_skill', 'real-skill'] },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('real-skill')
      expect(manifest.skills.length).toBe(1)
    })

    it('deduplicates agents and skills', () => {
      const workflow = {
        nodes: [
          { type: 'agent', agent_file: 'agents/dup.md', skills: ['skill-a'] },
          { type: 'bash', skills: ['skill-a', 'skill-b'] },
          { type: 'agent', agent_file: 'agents/dup.md' },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents.length).toBe(1)
      expect(manifest.skills.length).toBe(2)
    })

    it('handles empty workflow', () => {
      expect(preflight.analyze({}).agents).toEqual([])
      expect(preflight.analyze({}).skills).toEqual([])
      expect(preflight.analyze({ nodes: [] }).agents).toEqual([])
    })

    it('extracts agent_file from swarm expert_pool (dynamic mode)', () => {
      const workflow = {
        nodes: [
          {
            type: 'swarm',
            mode: 'debate',
            dynamic: true,
            expert_pool: [
              { role: 'architect', agent_file: 'agents/dynamic-expert-a.md' },
              { role: 'researcher', agent_file: 'agents/dynamic-expert-b.md' },
            ],
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('dynamic-expert-a')
      expect(manifest.agents).toContain('dynamic-expert-b')
    })

    it('extracts agent_file from swarm host agent', () => {
      const workflow = {
        nodes: [
          {
            type: 'swarm',
            mode: 'debate',
            dynamic: true,
            expert_pool: [],
            host: {
              role: 'synthesizer',
              agent_file: 'agents/host-synthesizer.md',
            },
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('host-synthesizer')
    })

    it('extracts agent_file from swarm aggregator (MOA mode)', () => {
      const workflow = {
        nodes: [
          {
            type: 'swarm',
            mode: 'moa',
            aggregator: {
              role: 'judge',
              agent_file: 'agents/moa-aggregator.md',
            },
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('moa-aggregator')
    })

    it('recurses into nested nodes (loop/condition children)', () => {
      const workflow = {
        nodes: [
          {
            type: 'loop',
            id: 'tdd-loop',
            nodes: [
              { type: 'agent', id: 'implement', skills: ['implement', 'tdd'] },
              { type: 'agent', id: 'review', skills: ['code-review', 'diagnosing-bugs'] },
            ],
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('implement')
      expect(manifest.skills).toContain('tdd')
      expect(manifest.skills).toContain('code-review')
      expect(manifest.skills).toContain('diagnosing-bugs')
    })

    it('extracts agent_file from sub-agent definitions', () => {
      const workflow = {
        nodes: [
          {
            type: 'agent',
            id: 'arch-review',
            agents: {
              'architecture-reviewer': {
                agent_file: '.claude/agents/architecture-explorer',
                model: 'pro',
              },
              'code-reviewer': {
                agent_file: '.claude/agents/engineering-code-reviewer',
              },
            },
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.agents).toContain('architecture-explorer')
      expect(manifest.agents).toContain('engineering-code-reviewer')
    })

    it('recurses into nested agents with sub-agent definitions', () => {
      const workflow = {
        nodes: [
          {
            type: 'loop',
            nodes: [
              {
                type: 'agent',
                skills: ['tdd'],
                agents: {
                  reviewer: { agent_file: '.claude/agents/code-reviewer' },
                },
              },
            ],
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('tdd')
      expect(manifest.agents).toContain('code-reviewer')
    })

    it('extracts skills from sub-agent definitions (agents.{name}.skills)', () => {
      const workflow = {
        nodes: [
          {
            type: 'agent',
            id: 'execution',
            agents: {
              implementer: {
                skills: ['octo-xzf-implementer'],
              },
              reviewer: {
                skills: ['code-review', 'octo-xzf-implementer'],
              },
            },
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('octo-xzf-implementer')
      expect(manifest.skills).toContain('code-review')
      // Should deduplicate
      expect(manifest.skills.filter(s => s === 'octo-xzf-implementer').length).toBe(1)
    })

    it('extracts skills from swarm expert_defaults.skills', () => {
      const workflow = {
        nodes: [
          {
            type: 'swarm',
            id: 'idea-research',
            expert_defaults: {
              skills: ['octo-xzf-research'],
              tools: ['Read', 'Grep'],
            },
            expert_pool: [
              { role: 'architect', agent_file: '.claude/agents/codebase-architect.md' },
            ],
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('octo-xzf-research')
      expect(manifest.agents).toContain('codebase-architect')
    })

    it('combines node-level skills with sub-agent skills', () => {
      const workflow = {
        nodes: [
          {
            type: 'agent',
            id: 'executor',
            skills: ['octo-xzf-init'],
            agents: {
              worker: {
                skills: ['octo-xzf-implementer'],
              },
            },
          },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.skills).toContain('octo-xzf-init')
      expect(manifest.skills).toContain('octo-xzf-implementer')
    })
  })

  describe('check', () => {
    it('detects available agents', () => {
      const agentsDir = path.join(tmpDir, '.claude', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'existing-agent.md'), '# Agent', 'utf-8')

      const result = preflight.check(
        { agents: ['existing-agent', 'missing-agent'], skills: [], commands: [], rules: [] },
        tmpDir,
      )

      expect(result.available).toEqual([{ type: 'agent', name: 'existing-agent' }])
      expect(result.missing).toEqual([{ type: 'agent', name: 'missing-agent' }])
    })

    it('detects available skills', () => {
      const skillsDir = path.join(tmpDir, '.claude', 'skills', 'my-skill')
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# Skill', 'utf-8')

      const result = preflight.check(
        { agents: [], skills: ['my-skill', 'no-skill'], commands: [], rules: [] },
        tmpDir,
      )

      expect(result.available).toEqual([{ type: 'skill', name: 'my-skill' }])
      expect(result.missing).toEqual([{ type: 'skill', name: 'no-skill' }])
    })

    it('all missing when workspace has no .claude dir', () => {
      const result = preflight.check(
        { agents: ['a'], skills: ['s'], commands: [], rules: [] },
        tmpDir,
      )
      expect(result.available.length).toBe(0)
      expect(result.missing.length).toBe(2)
    })

    it('all available when everything exists', () => {
      const agentsDir = path.join(tmpDir, '.claude', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'a.md'), '# A', 'utf-8')
      const skillDir = path.join(tmpDir, '.claude', 'skills', 's')
      fs.mkdirSync(skillDir, { recursive: true })

      const result = preflight.check(
        { agents: ['a'], skills: ['s'], commands: [], rules: [] },
        tmpDir,
      )
      expect(result.available.length).toBe(2)
      expect(result.missing.length).toBe(0)
    })

    it('detects available commands at .claude/commands/{name}.md', () => {
      const commandsDir = path.join(tmpDir, '.claude', 'commands')
      fs.mkdirSync(commandsDir, { recursive: true })
      fs.writeFileSync(path.join(commandsDir, 'cmd-review.md'), '# Command', 'utf-8')

      const result = preflight.check(
        { agents: [], skills: [], commands: ['cmd-review', 'missing-cmd'], rules: [] },
        tmpDir,
      )

      expect(result.available).toContainEqual({ type: 'command', name: 'cmd-review' })
      expect(result.missing).toContainEqual({ type: 'command', name: 'missing-cmd' })
    })

    it('detects available rules at .claude/rules/{name}.md', () => {
      const rulesDir = path.join(tmpDir, '.claude', 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.writeFileSync(path.join(rulesDir, 'code-style.md'), '# Rule', 'utf-8')

      const result = preflight.check(
        { agents: [], skills: [], commands: [], rules: ['code-style', 'missing-rule'] },
        tmpDir,
      )

      expect(result.available).toContainEqual({ type: 'rule', name: 'code-style' })
      expect(result.missing).toContainEqual({ type: 'rule', name: 'missing-rule' })
    })

    it('strips .md suffix from command names when checking', () => {
      const commandsDir = path.join(tmpDir, '.claude', 'commands')
      fs.mkdirSync(commandsDir, { recursive: true })
      fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy', 'utf-8')

      const result = preflight.check(
        { agents: [], skills: [], commands: ['deploy.md'], rules: [] },
        tmpDir,
      )

      expect(result.available).toContainEqual({ type: 'command', name: 'deploy.md' })
    })

    it('strips .md suffix from rule names when checking', () => {
      const rulesDir = path.join(tmpDir, '.claude', 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.writeFileSync(path.join(rulesDir, 'lint.md'), '# Lint', 'utf-8')

      const result = preflight.check(
        { agents: [], skills: [], commands: [], rules: ['lint.md'] },
        tmpDir,
      )

      expect(result.available).toContainEqual({ type: 'rule', name: 'lint.md' })
    })
  })

  describe('checkClones', () => {
    let origHome: string
    let fakeHome: string

    beforeEach(() => {
      fakeHome = createTempDir()
      origHome = os.homedir()
      // Override homedir via env — os.homedir() reads USERPROFILE on Windows, HOME on Unix
      if (process.platform === 'win32') {
        process.env.USERPROFILE = fakeHome
      } else {
        process.env.HOME = fakeHome
      }
    })

    afterEach(() => {
      // Restore original homedir
      if (process.platform === 'win32') {
        process.env.USERPROFILE = origHome
      } else {
        process.env.HOME = origHome
      }
      cleanupDir(fakeHome)
    })

    it('detects clone available at ~/.octopus/agent/clones/{name}/', () => {
      const cloneDir = path.join(fakeHome, '.octopus', 'agent', 'clones', 'my-clone')
      fs.mkdirSync(cloneDir, { recursive: true })

      const result = preflight.checkClones(['my-clone'])
      expect(result.available).toContainEqual({ type: 'clone', name: 'my-clone' })
      expect(result.missing.length).toBe(0)
    })

    it('detects clone available at ~/.octopus/agent/built-in/{name}/', () => {
      const builtinDir = path.join(fakeHome, '.octopus', 'agent', 'built-in', 'workspace')
      fs.mkdirSync(builtinDir, { recursive: true })

      const result = preflight.checkClones(['workspace'])
      expect(result.available).toContainEqual({ type: 'clone', name: 'workspace' })
      expect(result.missing.length).toBe(0)
    })

    it('detects clone missing when neither path exists', () => {
      const result = preflight.checkClones(['nonexistent-clone'])
      expect(result.available.length).toBe(0)
      expect(result.missing).toContainEqual({ type: 'clone', name: 'nonexistent-clone' })
    })

    it('handles mixed available and missing clones', () => {
      const cloneDir = path.join(fakeHome, '.octopus', 'agent', 'clones', 'installed')
      fs.mkdirSync(cloneDir, { recursive: true })

      const result = preflight.checkClones(['installed', 'not-installed'])
      expect(result.available).toContainEqual({ type: 'clone', name: 'installed' })
      expect(result.missing).toContainEqual({ type: 'clone', name: 'not-installed' })
    })

    it('returns empty results for empty input', () => {
      const result = preflight.checkClones([])
      expect(result.available.length).toBe(0)
      expect(result.missing.length).toBe(0)
    })
  })

  describe('analyze — new fields', () => {
    it('returns empty commands and rules arrays (no scanning from nodes)', () => {
      const workflow = {
        nodes: [
          { type: 'agent', agent_file: 'agents/test.md', skills: ['skill-a'] },
        ],
      }
      const manifest = preflight.analyze(workflow)
      expect(manifest.commands).toEqual([])
      expect(manifest.rules).toEqual([])
      // Existing fields still work
      expect(manifest.agents).toContain('test')
      expect(manifest.skills).toContain('skill-a')
    })
  })

  // ── 票11 (llm-wiki-loop): octo-wiki 预置链路 ─────────────────────────
  // Seam: 工作流节点声明 skills:[octo-wiki] → analyze 抽出 → check 报缺 →
  // 真实 ResourceManager(core-pack BuiltinProvider 目录扫描, 无中央清单)
  // registerBuiltins 后, ResourceProvisioner 把技能整目录物化进执行
  // workspace 的 .claude/skills/ —— 之后 SDK settingSources 原生发现
  // (providers/src/claude/provider.ts, ADR-0006: 不经任何 prompt 文本注入)。
  // 期望值来自票11/spec §执行身份 + 原型 Tab④ 四段骨架, 不反向抄实现 (防自证)。
  describe('octo-wiki provisioning (票11 llm-wiki-loop)', () => {
    const corePackBase = path.resolve(__dirname, '../../../../core-pack')

    it('core-pack 目录扫描自动注册 octo-wiki 为 builtin skill（无中央清单登记点）', () => {
      const rmBase = createTempDir()
      try {
        const manager = new ResourceManager({ basePath: rmBase, corePackBase })
        manager.registerBuiltins()
        const entry = manager.get('skill', 'octo-wiki')
        expect(entry).not.toBeNull()
        expect(entry!.installed).toBe(true)
        // installPath 必须指向实际物化目录（provisioner 按它整目录复制）
        expect(fs.existsSync(path.join(entry!.installPath, 'SKILL.md'))).toBe(true)
      } finally {
        cleanupDir(rmBase)
      }
    })

    it('声明 octo-wiki 的工作流经 analyze→check→provision 把技能物化进 workspace .claude/skills', async () => {
      const rmBase = createTempDir()
      const workspace = createTempDir()
      try {
        const manager = new ResourceManager({ basePath: rmBase, corePackBase })
        manager.registerBuiltins()

        // 节点声明 skills:[octo-wiki]（票10 后 as: 身份快照的 skills 也汇入此处）
        const workflow = { nodes: [{ type: 'agent', id: 'implement', skills: ['octo-wiki'] }] }
        const manifest = preflight.analyze(workflow)
        expect(manifest.skills).toContain('octo-wiki')

        // 执行前 workspace 尚无该技能 → preflight 判缺
        const check = preflight.check(manifest, workspace)
        expect(check.missing).toContainEqual({ type: 'skill', name: 'octo-wiki' })

        const result = await new ResourceProvisioner(manager).provision(check.missing, workspace)
        expect(result.failed).toHaveLength(0)
        expect(result.provisioned).toBeGreaterThanOrEqual(1)

        // 预置产物断言：SKILL.md 落在 .claude/skills/octo-wiki/（SDK project 设置源目录）
        const skillMd = path.join(workspace, '.claude', 'skills', 'octo-wiki', 'SKILL.md')
        expect(fs.existsSync(skillMd)).toBe(true)

        // 四段骨架齐备（原型 Tab④ 锚点：导航协议/引用纪律是票12 wiki_refs 信道对接口）
        const text = fs.readFileSync(skillMd, 'utf-8')
        for (const anchor of ['name: octo-wiki', '## 何时查阅', '## 导航协议', '## 引用纪律', '## 禁止']) {
          expect(text).toContain(anchor)
        }

        // 复跑 preflight：已 available，不再缺（幂等，引擎 init Step1/Step2 双趟都安全）
        const recheck = preflight.check(manifest, workspace)
        expect(recheck.available).toContainEqual({ type: 'skill', name: 'octo-wiki' })
        expect(recheck.missing).toHaveLength(0)
      } finally {
        cleanupDir(rmBase)
        cleanupDir(workspace)
      }
    })

    it('octo-wiki 走共享层（core-pack/skills），绝不落分身层 clone-tier（ADR-0006 写侧隔离）', () => {
      // 读侧技能若在 clones/*/skills 出现，等于泄漏给单个分身之外的写权面
      const clonesDir = path.join(corePackBase, 'clones')
      const offenders: string[] = []
      if (fs.existsSync(clonesDir)) {
        for (const clone of fs.readdirSync(clonesDir)) {
          const tierSkill = path.join(clonesDir, clone, 'skills', 'octo-wiki')
          if (fs.existsSync(tierSkill)) offenders.push(`${clone}/skills/octo-wiki`)
        }
      }
      expect(offenders).toEqual([])
    })
  })
})
