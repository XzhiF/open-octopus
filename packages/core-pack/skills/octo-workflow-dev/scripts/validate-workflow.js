#!/usr/bin/env node
/**
 * Octopus Workflow Validation Script — L1 + L2 + L3
 *
 * Usage:
 *   node validate-workflow.js ./my-workflow.yaml
 *   node validate-workflow.js ./my-workflow.yaml --json
 *   node validate-workflow.js ./workflows/*.yaml
 *
 * Validation Levels:
 *   L1 (Structure): YAML parseable, required fields present, types correct (incl. goal-mode node fields: max_turns/max_budget_usd number|string, tools/disallowed_tools string[])
 *   L2 (Cross-constraints): Swarm mutual exclusions, goal/prompt exclusivity, planning deprecation (migration error), non-claude engine claude-only-field warnings, condition default order, depends_on references exist
 *   L3 (Semantic): Variable syntax, expression syntax, interaction_exit_when syntax
 *
 * Hard Checks (Warnings):
 *   - Non-first top-level nodes without depends_on
 *   - Loop sub-nodes without depends_on
 *
 * Exit codes: 0 = all pass, 1 = errors found, 2 = warnings only (no errors)
 */

const fs = require('fs')
const path = require('path')

// ── goal-task-dev parser mirrors (authority: packages/shared/src/yaml/parser.ts) ──

// Deprecated `planning:` block (K4) — parser raises a ValueError pre-Zod.
const PLANNING_MIGRATION = 'planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除'

// Node fields only honored by the claude engine (K8) — validate warns, runtime ignores.
const CLAUDE_ONLY_NODE_FIELDS = ['max_turns', 'max_budget_usd', 'tools', 'disallowed_tools']

// ── YAML Loading ──────────────────────────────────────────────────────────────

function tryRequireYaml() {
  try { return require('js-yaml') } catch { /* continue */ }

  const os = require('os')
  let root = __dirname
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(root)
    if (parent === root) break
    root = parent
    if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ||
        (fs.existsSync(path.join(root, 'packages')) && fs.existsSync(path.join(root, 'package.json')))) {
      break
    }
  }

  const searchDirs = [root, process.cwd(), __dirname, os.homedir()]
  const packagesDir = path.join(root, 'packages')
  if (fs.existsSync(packagesDir)) {
    for (const p of fs.readdirSync(packagesDir)) {
      searchDirs.push(path.join(packagesDir, p))
    }
  }

  for (const d of searchDirs) {
    const p = path.join(d, 'node_modules', 'js-yaml')
    try {
      if (fs.existsSync(p)) return require(p)
    } catch { /* continue */ }
  }

  throw new Error('js-yaml not found — run pnpm install or npm install js-yaml')
}

// ── Result Helpers ─────────────────────────────────────────────────────────────

class ValidationResult {
  constructor(file) {
    this.file = file
    this.errors = []    // L1, L2, L3 errors
    this.warnings = []  // Hard checks (non-fatal)
    this.skippedFixture = false // top-level `scenarios` → test fixture, not a workflow
  }

  addError(level, message, nodeId) {
    this.errors.push({ level, message, nodeId: nodeId || null })
  }

  addWarning(message, nodeId) {
    this.warnings.push({ message, nodeId: nodeId || null })
  }

  get ok() { return this.errors.length === 0 }
  get hasWarnings() { return this.warnings.length > 0 }
}

// ── L1: Structure Validation ───────────────────────────────────────────────────

function validateL1(yaml, result) {
  // apiVersion
  if (typeof yaml.apiVersion !== 'string' || !/^octopus\/v\d+$/.test(yaml.apiVersion)) {
    result.addError('L1', `apiVersion format error: "${yaml.apiVersion}", expected "octopus/v{N}" (e.g., "octopus/v1")`)
  }

  // kind
  if (yaml.kind !== 'Workflow') {
    result.addError('L1', `kind must be "Workflow", got: "${yaml.kind}"`)
  }

  // name
  if (typeof yaml.name !== 'string' || !yaml.name) {
    result.addError('L1', 'Missing required field: name')
  }

  // inputs — values must be objects
  if (yaml.inputs && typeof yaml.inputs === 'object') {
    for (const [key, val] of Object.entries(yaml.inputs)) {
      if (val === null || typeof val !== 'object') {
        result.addError('L1', `inputs.${key} must be an object { description, required?, default? }, not a bare value`)
      } else if (typeof val.description !== 'string') {
        result.addError('L1', `inputs.${key} missing required description field`)
      }
    }
  }

  // nodes
  if (!Array.isArray(yaml.nodes) || yaml.nodes.length === 0) {
    result.addError('L1', 'nodes must be a non-empty array')
    return
  }

  // Node ID uniqueness (recursive)
  const ids = new Set()
  const collectIds = (nodes, prefix) => {
    for (const n of nodes) {
      if (!n.id || typeof n.id !== 'string') {
        result.addError('L1', 'Each node must have a string id field', prefix)
        continue
      }
      const fullId = prefix ? `${prefix}/${n.id}` : n.id
      if (ids.has(n.id)) {
        result.addError('L1', `Duplicate node id: "${n.id}"`, n.id)
      }
      ids.add(n.id)
      if (n.nodes) collectIds(n.nodes, fullId)
    }
  }
  collectIds(yaml.nodes, '')

  // Per-type required fields (recursive)
  const validateNodeFields = (node) => {
    switch (node.type) {
      case 'bash':
        if (!node.bash) {
          result.addError('L1', `type=bash requires bash field`, node.id)
        }
        break
      case 'python':
        if (!node.python) {
          result.addError('L1', `type=python requires python field`, node.id)
        }
        break
      case 'agent':
        if (!node.agent && !node.prompt && !node.goal && !node.agents) {
          result.addError('L1', `type=agent requires at least one of: agent, prompt, goal, agents`, node.id)
        }
        break
      case 'condition':
        if (!node.cases || !Array.isArray(node.cases) || node.cases.length === 0) {
          result.addError('L1', `type=condition requires non-empty cases array`, node.id)
        }
        break
      case 'approval':
        // No special required fields
        break
      case 'loop':
        if (!node.max_iterations) {
          result.addError('L1', `type=loop requires max_iterations field`, node.id)
        }
        if (node.nodes) {
          for (const inner of node.nodes) {
            validateNodeFields(inner)
          }
        }
        break
      case 'swarm':
        if (!node.topic) {
          result.addError('L1', `type=swarm requires topic field`, node.id)
        }
        if (!node.mode) {
          result.addError('L1', `type=swarm requires mode field`, node.id)
        }
        if (node.mode && !['review', 'debate', 'dispatch', 'swarm', 'moa'].includes(node.mode)) {
          result.addError('L1', `type=swarm mode must be one of: review, debate, dispatch, swarm, moa. Got: "${node.mode}"`, node.id)
        }
        break
      case 'interaction':
        if (!node.interaction_agent && !node.interaction_exit_when) {
          result.addError('L1', `type=interaction requires at least one of: interaction_agent, interaction_exit_when`, node.id)
        }
        break
      case 'sub_workflow':
        if (!node.workflow) {
          result.addError('L1', `type=sub_workflow requires workflow field`, node.id)
        }
        break
      case 'dynamic_sub_workflow':
        if (!node.prompt) {
          result.addError('L1', `type=dynamic_sub_workflow requires prompt field`, node.id)
        }
        break
      case 'task_dispatch':
        // subunit is a string reference (e.g. "$iteration.subunit") resolved by
        // the TaskDispatchExecutor at runtime from the composition loop context.
        // await: true triggers G1 pause-resume (child schedule completion resumes
        // the parent composition-wf node). input_mapping/output_mapping reused
        // from sub_workflow. Used inside a composition workflow's subunit loop.
        if (!node.subunit) {
          result.addError('L1', `type=task_dispatch requires subunit field (string reference, e.g. "$iteration.subunit")`, node.id)
        }
        break
      default:
        if (node.type) {
          result.addError('L1', `Unknown node type: "${node.type}"`, node.id)
        } else {
          result.addError('L1', `Node missing type field`, node.id)
        }
    }
  }

  for (const node of yaml.nodes) {
    validateNodeFields(node)
  }

  // Node-level new fields (goal-task-dev): type contract mirrors shared NodeSchema
  //   max_turns / max_budget_usd : number | string (string supports $inputs interpolation)
  //   tools / disallowed_tools   : string[]
  const validateGoalFieldTypes = (node) => {
    for (const f of ['max_turns', 'max_budget_usd']) {
      if (node[f] !== undefined && typeof node[f] !== 'number' && typeof node[f] !== 'string') {
        result.addError('L1', `"${f}" must be number or string (string allows $inputs interpolation), got ${typeof node[f]}`, node.id)
      }
    }
    for (const f of ['tools', 'disallowed_tools']) {
      if (node[f] !== undefined && (!Array.isArray(node[f]) || node[f].some(v => typeof v !== 'string'))) {
        result.addError('L1', `"${f}" must be an array of strings`, node.id)
      }
    }
    if (node.nodes) {
      for (const inner of node.nodes) validateGoalFieldTypes(inner)
    }
  }
  for (const node of yaml.nodes) {
    validateGoalFieldTypes(node)
  }
}

// ── L2: Cross-Constraint Validation ───────────────────────────────────────────

function validateL2(yaml, result) {
  const validateNode = (node) => {
    // Deprecated `planning:` block → migration error (mirrors parser.ts pre-Zod recursive scan, K4)
    if (node.planning !== undefined) {
      result.addError('L2', `node "${node.id}": ${PLANNING_MIGRATION}`, node.id)
    }

    // claude-only fields on non-claude engine → warning, runtime silently ignores (mirrors validateWorkflow, K8).
    // Engine resolution chain: node.engine ?? workflow.engine ?? "claude"; "claude-code" is a claude alias.
    const nodeEngine = node.engine || yaml.engine || 'claude'
    if (nodeEngine !== 'claude' && nodeEngine !== 'claude-code') {
      const used = CLAUDE_ONLY_NODE_FIELDS.filter(f => node[f] !== undefined)
      if (used.length > 0) {
        result.addWarning(`node "${node.id}": engine "${nodeEngine}" does not support claude-only fields (${used.join(', ')}) — they will be ignored at runtime`, node.id)
      }
    }

    // Agent: goal and prompt mutual exclusion
    if (node.type === 'agent' && node.goal && node.prompt) {
      result.addError('L2', `agent node cannot have both goal and prompt (mutually exclusive)`, node.id)
    }

    // Condition: default must be last
    if (node.type === 'condition' && node.cases && Array.isArray(node.cases)) {
      const defaultIdx = node.cases.findIndex(c => c.when === 'default')
      if (defaultIdx >= 0 && defaultIdx !== node.cases.length - 1) {
        result.addError('L2', `condition case "when: default" must be the last case (found at position ${defaultIdx + 1} of ${node.cases.length})`, node.id)
      }
    }

    // Swarm cross-constraints
    if (node.type === 'swarm') {
      // expert_pool and experts mutually exclusive
      if (node.expert_pool && node.experts && node.experts.length > 0) {
        result.addError('L2', `expert_pool and experts are mutually exclusive — use expert_pool for dynamic selection, experts for fixed roster`, node.id)
      }

      // moa requires aggregator
      if (node.mode === 'moa' && !node.aggregator) {
        result.addError('L2', `mode: moa requires aggregator field`, node.id)
      }

      // moa requires experts >= 2
      if (node.mode === 'moa' && !node.dynamic && node.experts && node.experts.length < 2) {
        result.addError('L2', `mode: moa requires at least 2 experts, got ${node.experts.length}`, node.id)
      }

      // debate requires experts >= 2
      if (node.mode === 'debate' && !node.dynamic && node.experts && node.experts.length < 2) {
        result.addError('L2', `mode: debate requires at least 2 experts, got ${node.experts.length}`, node.id)
      }

      // review requires experts >= 1
      if (node.mode === 'review' && !node.dynamic && (!node.experts || node.experts.length < 1)) {
        result.addError('L2', `mode: review requires at least 1 expert`, node.id)
      }

      // moa rounds 0-5
      if (node.mode === 'moa' && node.rounds !== undefined && (node.rounds < 0 || node.rounds > 5)) {
        result.addError('L2', `mode: moa rounds must be 0-5, got ${node.rounds}`, node.id)
      }

      // debate/review rounds >= 1
      if ((node.mode === 'debate' || node.mode === 'review') && node.rounds !== undefined && node.rounds < 1) {
        result.addError('L2', `mode: ${node.mode} rounds must be >= 1, got ${node.rounds}`, node.id)
      }

      // dynamic requires max_experts
      if (node.dynamic && !node.max_experts) {
        result.addError('L2', `dynamic: true requires max_experts field`, node.id)
      }

      // expert_pool constraints
      if (node.expert_pool) {
        if (node.expert_pool.length < 2) {
          result.addError('L2', `expert_pool requires at least 2 experts, got ${node.expert_pool.length}`, node.id)
        }
        if (node.max_experts && node.max_experts > node.expert_pool.length) {
          result.addError('L2', `max_experts (${node.max_experts}) cannot exceed expert_pool size (${node.expert_pool.length})`, node.id)
        }
      }

      // Expert depends_on reference validation
      if (node.experts) {
        const roles = new Set(node.experts.map(e => e.role))
        for (const expert of node.experts) {
          if (expert.depends_on) {
            for (const dep of expert.depends_on) {
              if (!roles.has(dep)) {
                result.addError('L2', `swarm expert depends_on references non-existent role "${dep}", available: [${[...roles].join(', ')}]`, node.id)
              }
            }
          }
        }
      }
    }

    // Recurse into loop sub-nodes
    if (node.nodes) {
      for (const inner of node.nodes) {
        validateNode(inner)
      }
    }
  }

  // depends_on reference validation (all nodes, recursive)
  const allIds = new Set()
  const collectIds = (nodes) => {
    for (const n of nodes) {
      if (n.id) allIds.add(n.id)
      if (n.nodes) collectIds(n.nodes)
    }
  }
  collectIds(yaml.nodes)

  const validateDependsOn = (nodes) => {
    for (const node of nodes) {
      if (node.depends_on) {
        for (const dep of node.depends_on) {
          if (!allIds.has(dep)) {
            result.addError('L2', `depends_on references non-existent node "${dep}"`, node.id)
          }
        }
      }
      if (node.nodes) validateDependsOn(node.nodes)
    }
  }
  validateDependsOn(yaml.nodes)

  for (const node of yaml.nodes) {
    validateNode(node)
  }
}

// ── L3: Semantic Validation ───────────────────────────────────────────────────

function validateL3(yaml, result) {
  // Expression syntax validation
  const validateExpression = (expr, nodeId, fieldName) => {
    if (!expr || typeof expr !== 'string') return
    if (expr === 'default') return // condition default case

    // Check for common syntax errors
    // Unquoted string comparison
    const unquotedCompare = /==\s*([a-zA-Z][a-zA-Z0-9_-]*)(?!\s*")/
    if (unquotedCompare.test(expr) && !expr.includes('"') && !expr.includes("'")) {
      result.addWarning(`Possible unquoted string in ${fieldName}: "${expr}". String comparisons need quotes: == "value"`, nodeId)
    }
  }

  const validateNodeExpressions = (node) => {
    // execute_when
    validateExpression(node.execute_when, node.id, 'execute_when')

    // outputs values
    if (node.outputs) {
      for (const [key, val] of Object.entries(node.outputs)) {
        validateExpression(val, node.id, `outputs.${key}`)
      }
    }

    // condition cases
    if (node.type === 'condition' && node.cases) {
      for (const c of node.cases) {
        validateExpression(c.when, node.id, 'condition.cases.when')
      }
    }

    // loop expressions
    if (node.type === 'loop') {
      validateExpression(node.while, node.id, 'loop.while')
      validateExpression(node.break_when, node.id, 'loop.break_when')
      validateExpression(node.continue_when, node.id, 'loop.continue_when')
    }

    // interaction_exit_when
    if (node.type === 'interaction') {
      validateExpression(node.interaction_exit_when, node.id, 'interaction_exit_when')
    }

    // Recurse into loop sub-nodes
    if (node.nodes) {
      for (const inner of node.nodes) {
        validateNodeExpressions(inner)
      }
    }
  }

  for (const node of yaml.nodes) {
    validateNodeExpressions(node)
  }
}

// ── Hard Checks (Warnings) ────────────────────────────────────────────────────

function validateHardChecks(yaml, result) {
  // depends_on completeness: non-first top-level nodes without depends_on
  if (yaml.nodes && yaml.nodes.length > 1) {
    for (let i = 1; i < yaml.nodes.length; i++) {
      const node = yaml.nodes[i]
      if (!node.depends_on || node.depends_on.length === 0) {
        result.addWarning(
          `Node "${node.id}" (position ${i + 1}) has no depends_on — will execute as independent root in auto mode. Add depends_on for correct DAG ordering.`,
          node.id
        )
      }
    }
  }

  // Loop sub-nodes without depends_on
  const checkLoopSubNodes = (node) => {
    if (node.type === 'loop' && node.nodes && node.nodes.length > 1) {
      for (let i = 1; i < node.nodes.length; i++) {
        const inner = node.nodes[i]
        if (!inner.depends_on || inner.depends_on.length === 0) {
          result.addWarning(
            `Loop sub-node "${inner.id}" (position ${i + 1} in loop "${node.id}") has no depends_on — visualization may overlap, execution order may be incorrect`,
            inner.id
          )
        }
      }
    }
    if (node.nodes) {
      for (const inner of node.nodes) {
        checkLoopSubNodes(inner)
      }
    }
  }

  for (const node of yaml.nodes) {
    checkLoopSubNodes(node)
  }
}

// ── Main Validation Entry ─────────────────────────────────────────────────────

function validateFile(filePath) {
  const result = new ValidationResult(filePath)

  let yamlLib
  try {
    yamlLib = tryRequireYaml()
  } catch (e) {
    result.addError('L1', `Cannot load js-yaml: ${e.message}`)
    return result
  }

  let content
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    result.addError('L1', `Cannot read file "${filePath}": ${e.message}`)
    return result
  }

  let yaml
  try {
    yaml = yamlLib.load(content)
  } catch (e) {
    result.addError('L1', `YAML parse error: ${e.message}`)
    return result
  }

  if (!yaml || typeof yaml !== 'object') {
    result.addError('L1', 'YAML content is empty or not an object')
    return result
  }

  // Test fixtures (*.test.yaml: top-level `scenarios`) are not workflows —
  // skip workflow schema checks; they are verified via `octopus workflow simulate`.
  if (Array.isArray(yaml.scenarios)) {
    result.skippedFixture = true
    return result
  }

  validateL1(yaml, result)
  if (!result.ok) return result // Stop early on L1 errors

  validateL2(yaml, result)
  validateL3(yaml, result)
  validateHardChecks(yaml, result)

  return result
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const files = args.filter(a => !a.startsWith('--'))

  if (files.length === 0) {
    console.error('Usage: node validate-workflow.js <yaml-file> [--json]')
    console.error('       node validate-workflow.js ./workflows/*.yaml')
    process.exit(1)
  }

  // Glob expansion
  const allFiles = []
  for (const f of files) {
    if (f.includes('*')) {
      // Simple glob expansion (no external dependencies)
      const dir = path.dirname(f)
      const pat = path.basename(f).replace(/\*/g, '(.*)')
      if (fs.existsSync(dir)) {
        const regex = new RegExp('^' + pat + '$')
        allFiles.push(...fs.readdirSync(dir).filter(fn => regex.test(fn)).map(fn => path.join(dir, fn)))
      }
    } else {
      if (!fs.existsSync(f)) {
        console.error(`File not found: ${f}`)
        continue
      }
      allFiles.push(f)
    }
  }

  const results = []
  let hasErrors = false
  let hasWarningsOnly = false

  for (const f of allFiles) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
    const result = validateFile(f)
    results.push(result)
    if (!result.ok) hasErrors = true
    else if (result.hasWarnings) hasWarningsOnly = true
  }

  // Output
  if (jsonMode) {
    const output = results.map(r => ({
      file: r.file,
      ok: r.ok,
      skippedFixture: r.skippedFixture,
      errors: r.errors,
      warnings: r.warnings,
    }))
    console.log(JSON.stringify(output, null, 2))
  } else {
    let passedCount = 0
    let failedCount = 0
    let warningCount = 0
    let fixtureCount = 0

    for (const r of results) {
      if (r.skippedFixture) {
        console.log(`○ ${r.file} (test fixture — verify via "octopus workflow simulate")`)
        fixtureCount++
        continue
      }
      if (r.ok) {
        console.log(`✓ ${r.file}`)
        passedCount++
      } else {
        console.log(`✗ ${r.file}`)
        for (const err of r.errors) {
          const nodeId = err.nodeId ? ` [${err.nodeId}]` : ''
          console.log(`  ${err.level} ERROR${nodeId}: ${err.message}`)
        }
        failedCount++
      }

      if (r.warnings.length > 0) {
        for (const w of r.warnings) {
          const nodeId = w.nodeId ? ` [${w.nodeId}]` : ''
          console.log(`  ⚠ WARNING${nodeId}: ${w.message}`)
        }
        warningCount += r.warnings.length
      }
    }

    console.log(`\n${passedCount} passed, ${failedCount} failed${fixtureCount ? `, ${fixtureCount} fixture(s) skipped` : ''}`)
    if (warningCount > 0) {
      console.log(`${warningCount} warning(s)`)
    }
  }

  if (hasErrors) process.exit(1)
  if (hasWarningsOnly) process.exit(2) // 2 = warnings only (no errors)
  process.exit(0)
}

main()
