import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ResourcePreFlight } from '../resource-preflight'

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
  })

  describe('check', () => {
    it('detects available agents', () => {
      const agentsDir = path.join(tmpDir, '.claude', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'existing-agent.md'), '# Agent', 'utf-8')

      const result = preflight.check(
        { agents: ['existing-agent', 'missing-agent'], skills: [] },
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
        { agents: [], skills: ['my-skill', 'no-skill'] },
        tmpDir,
      )

      expect(result.available).toEqual([{ type: 'skill', name: 'my-skill' }])
      expect(result.missing).toEqual([{ type: 'skill', name: 'no-skill' }])
    })

    it('all missing when workspace has no .claude dir', () => {
      const result = preflight.check(
        { agents: ['a'], skills: ['s'] },
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
        { agents: ['a'], skills: ['s'] },
        tmpDir,
      )
      expect(result.available.length).toBe(2)
      expect(result.missing.length).toBe(0)
    })
  })
})
