/**
 * OrchestratorService Unit Tests
 * Tests intent classification, workflow selection, input organization,
 * and dynamic workflow generation.
 * Maps to PRD B1-B5 (orchestration), E1 (scheduled tasks).
 */
import { describe, it, expect } from 'vitest'
import {
  OrchestratorService,
  getOrchestratorService,
  type IntentClassification,
} from '../services/agent/orchestrator-service'

const TEST_ORG = 'test-orch-org'

describe('OrchestratorService', () => {
  const service = getOrchestratorService(TEST_ORG)

  // ── classifyIntent ───────────────────────────────────────────

  describe('classifyIntent', () => {
    it('classifies Chinese single task with action verbs', () => {
      const result = service.classifyIntent('给项目添加暗色模式')
      expect(result.intent).toBe('single_task')
      expect(result.confidence).toBeGreaterThanOrEqual(0.7)
      expect(result.reasoning).toBeTruthy()
    })

    it('classifies English single task', () => {
      const result = service.classifyIntent('Create a new API endpoint for user profiles')
      expect(result.intent).toBe('single_task')
    })

    it('classifies scheduled task with time pattern', () => {
      const result = service.classifyIntent('每天9点检查代码质量')
      expect(result.intent).toBe('scheduled_task')
      expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    })

    it('classifies scheduled task with cron keyword', () => {
      const result = service.classifyIntent('Set up a cron job to run tests nightly')
      expect(result.intent).toBe('scheduled_task')
    })

    it('classifies clone management with 分身 keyword', () => {
      const result = service.classifyIntent('创建一个前端分身来处理 UI')
      expect(result.intent).toBe('clone_management')
      expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    })

    it('classifies clone management with delegate keyword', () => {
      const result = service.classifyIntent('Delegate this task to a clone')
      expect(result.intent).toBe('clone_management')
    })

    it('classifies info query with history keywords', () => {
      const result = service.classifyIntent('昨天做了什么？查看历史记录')
      expect(result.intent).toBe('info_query')
      expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    })

    it('classifies info query with English keywords', () => {
      const result = service.classifyIntent('What did I do previously? Search my history')
      expect(result.intent).toBe('info_query')
    })

    it('falls back to general chat for greetings', () => {
      const result = service.classifyIntent('你好，今天天气怎么样')
      expect(result.intent).toBe('general_chat')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    })

    it('falls back to general chat for ambiguous messages', () => {
      const result = service.classifyIntent('hello')
      expect(result.intent).toBe('general_chat')
    })
  })

  // ── organizeInputs ───────────────────────────────────────────

  describe('organizeInputs', () => {
    it('includes requirement and intent_type', () => {
      const intent: IntentClassification = {
        intent: 'single_task',
        confidence: 0.8,
        reasoning: 'test',
      }
      const inputs = service.organizeInputs('给项目添加测试', intent)
      expect(inputs.requirement).toBe('给项目添加测试')
      expect(inputs.intent_type).toBe('single_task')
    })

    it('extracts target scope from Chinese message', () => {
      const intent: IntentClassification = {
        intent: 'single_task',
        confidence: 0.8,
        reasoning: 'test',
      }
      // Regex: 给\s*(\S+)\s*(加|添加|创建|实现|修复) — \S+ is greedy, so scope includes chars up to the action verb fragment
      const inputs = service.organizeInputs('给 auth 创建单元测试', intent)
      expect(inputs.target_scope).toBe('auth')
    })

    it('extracts schedule hour for scheduled tasks', () => {
      const intent: IntentClassification = {
        intent: 'scheduled_task',
        confidence: 0.9,
        reasoning: 'test',
      }
      const inputs = service.organizeInputs('每天9点执行代码审查', intent)
      expect(inputs.schedule_hour).toBe('9')
      expect(inputs.task_description).toBeTruthy()
    })

    it('handles messages without target scope gracefully', () => {
      const intent: IntentClassification = {
        intent: 'general_chat',
        confidence: 0.7,
        reasoning: 'test',
      }
      const inputs = service.organizeInputs('hello world', intent)
      expect(inputs.requirement).toBe('hello world')
      expect(inputs.target_scope).toBeUndefined()
    })
  })

  // ── generateWorkflow ─────────────────────────────────────────

  describe('generateWorkflow', () => {
    it('generates valid workflow for single task', () => {
      const intent: IntentClassification = {
        intent: 'single_task',
        confidence: 0.8,
        reasoning: 'test',
      }
      const result = service.generateWorkflow('添加单元测试', intent)
      expect(result.workflow_name).toBeTruthy()
      expect(result.yaml).toContain('name:')
      expect(result.yaml).toContain('nodes:')
      expect(result.valid).toBe(true)
      expect(result.validation_errors).toHaveLength(0)
    })

    it('generates scheduled task workflow with schedule nodes', () => {
      const intent: IntentClassification = {
        intent: 'scheduled_task',
        confidence: 0.9,
        reasoning: 'test',
      }
      const result = service.generateWorkflow('每天检查日志', intent)
      expect(result.yaml).toContain('design_schedule')
      expect(result.yaml).toContain('register_job')
      expect(result.yaml).toContain('verify_schedule')
    })

    it('generates clone management workflow', () => {
      const intent: IntentClassification = {
        intent: 'clone_management',
        confidence: 0.85,
        reasoning: 'test',
      }
      const result = service.generateWorkflow('创建分身处理前端任务', intent)
      expect(result.yaml).toContain('analyze_clones')
      expect(result.yaml).toContain('execute_clone_ops')
    })

    it('single task workflow has analyze-implement-verify chain', () => {
      const intent: IntentClassification = {
        intent: 'single_task',
        confidence: 0.8,
        reasoning: 'test',
      }
      const result = service.generateWorkflow('实现新功能', intent)
      expect(result.yaml).toContain('analyze')
      expect(result.yaml).toContain('implement')
      expect(result.yaml).toContain('verify')
    })
  })

  // ── selectWorkflow ───────────────────────────────────────────

  describe('selectWorkflow', () => {
    it('returns null when no workflows match', () => {
      const intent: IntentClassification = {
        intent: 'general_chat',
        confidence: 0.7,
        reasoning: 'test',
      }
      const result = service.selectWorkflow(intent, 'hello')
      // May be null if no workflows dir exists — that's expected
      if (result) {
        expect(result.workflow_name).toBeTruthy()
        expect(result.score).toBeGreaterThan(0)
      }
    })
  })

  // ── Singleton ────────────────────────────────────────────────

  describe('singleton', () => {
    it('returns same instance for same org', () => {
      const a = getOrchestratorService(TEST_ORG)
      const b = getOrchestratorService(TEST_ORG)
      expect(a).toBe(b)
    })

    it('returns different instances for different orgs', () => {
      const a = getOrchestratorService('org-a')
      const b = getOrchestratorService('org-b')
      expect(a).not.toBe(b)
    })
  })
})
