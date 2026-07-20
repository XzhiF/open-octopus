import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DiscussionCoordinator } from '../services/swarm/discussion-coordinator'

describe('DiscussionCoordinator', () => {
  let tmpDir: string
  let coord: DiscussionCoordinator

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-coord-test-'))
    coord = new DiscussionCoordinator(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Expert limit enforcement ────────────────────────────────────

  it('rejects more than 5 experts', async () => {
    const experts = ['a', 'b', 'c', 'd', 'e', 'f']
    await expect(coord.startDiscussion('topic', experts))
      .rejects.toThrow('Expert limit is 5, got 6')
  })

  it('accepts exactly 5 experts', async () => {
    const result = await coord.startDiscussion('topic', ['a', 'b', 'c', 'd', 'e'])
    expect(result.expertOpinions).toHaveLength(5)
  })

  it('rejects empty experts array', async () => {
    await expect(coord.startDiscussion('topic', []))
      .rejects.toThrow('At least one expert is required')
  })

  it('works with a single expert', async () => {
    const result = await coord.startDiscussion('topic', ['solo'])
    expect(result.expertOpinions).toHaveLength(1)
    expect(result.expertOpinions[0].expert).toBe('solo')
  })

  // ── Synthesis output ────────────────────────────────────────────

  it('produces a final proposal containing topic and expert names', async () => {
    const result = await coord.startDiscussion('AI Safety', ['researcher', 'engineer'])

    expect(result.finalProposal).toContain('AI Safety')
    expect(result.finalProposal).toContain('researcher')
    expect(result.finalProposal).toContain('engineer')
    expect(result.finalProposal).toContain('## Proposal')
    expect(result.finalProposal).toContain('### Synthesis')
  })

  it('includes confidence scores in the proposal', async () => {
    const result = await coord.startDiscussion('topic', ['exp1', 'exp2'])

    expect(result.finalProposal).toContain('confidence: 0.7')
  })

  it('returns all expected DiscussionResult fields', async () => {
    const result = await coord.startDiscussion('my topic', ['alice'])

    expect(result.id).toBeDefined()
    expect(typeof result.id).toBe('string')
    expect(result.topic).toBe('my topic')
    expect(result.expertOpinions).toHaveLength(1)
    expect(typeof result.finalProposal).toBe('string')
    expect(typeof result.conversationLog).toBe('string')
  })

  // ── ExpertOpinion shape ─────────────────────────────────────────

  it('generates opinions with correct shape', async () => {
    const result = await coord.startDiscussion('topic', ['analyst'])
    const op = result.expertOpinions[0]

    expect(op.expert).toBe('analyst')
    expect(typeof op.opinion).toBe('string')
    expect(op.opinion).toContain('analyst')
    expect(typeof op.confidence).toBe('number')
    expect(op.confidence).toBeGreaterThan(0)
    expect(op.confidence).toBeLessThanOrEqual(1)
  })

  // ── JSONL log creation ──────────────────────────────────────────

  it('creates a JSONL log file on disk', async () => {
    const result = await coord.startDiscussion('topic', ['a', 'b'])

    const logFile = path.join(tmpDir, `${result.id}.jsonl`)
    expect(fs.existsSync(logFile)).toBe(true)

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n')
    // start + 2 opinions + synthesis + end = 5 lines
    expect(lines).toHaveLength(5)

    const events = lines.map(l => JSON.parse(l).event)
    expect(events[0]).toBe('start')
    expect(events[1]).toBe('opinion')
    expect(events[2]).toBe('opinion')
    expect(events[3]).toBe('synthesis')
    expect(events[4]).toBe('end')
  })

  it('JSONL start event contains topic and experts', async () => {
    const result = await coord.startDiscussion('scaling', ['x', 'y'])
    const logFile = path.join(tmpDir, `${result.id}.jsonl`)
    const firstLine = JSON.parse(fs.readFileSync(logFile, 'utf-8').split('\n')[0])

    expect(firstLine.topic).toBe('scaling')
    expect(firstLine.experts).toEqual(['x', 'y'])
  })

  it('JSONL opinion events contain expert name and confidence', async () => {
    const result = await coord.startDiscussion('t', ['bob'])
    const logFile = path.join(tmpDir, `${result.id}.jsonl`)
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n')
    const opinionLine = JSON.parse(lines[1])

    expect(opinionLine.event).toBe('opinion')
    expect(opinionLine.expert).toBe('bob')
    expect(typeof opinionLine.confidence).toBe('number')
  })

  it('JSONL synthesis event contains the final proposal', async () => {
    const result = await coord.startDiscussion('t', ['a'])
    const logFile = path.join(tmpDir, `${result.id}.jsonl`)
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n')
    const synthLine = JSON.parse(lines[2]) // start, opinion, synthesis

    expect(synthLine.event).toBe('synthesis')
    expect(synthLine.finalProposal).toBe(result.finalProposal)
  })

  it('creates logDir if it does not exist', async () => {
    const deepDir = path.join(tmpDir, 'deep', 'nested', 'dir')
    const deepCoord = new DiscussionCoordinator(deepDir)

    await deepCoord.startDiscussion('topic', ['a'])

    expect(fs.existsSync(deepDir)).toBe(true)
  })

  // ── conversationLog consistency ─────────────────────────────────

  it('conversationLog matches the file content', async () => {
    const result = await coord.startDiscussion('topic', ['a'])
    const logFile = path.join(tmpDir, `${result.id}.jsonl`)
    const fileContent = fs.readFileSync(logFile, 'utf-8')

    expect(result.conversationLog).toBe(fileContent)
  })
})
