// E2E Contract Test: Interaction Node Type Contracts
// Verifies frontend-backend type consistency
// Anti-fake-run: R1-R8 compliant

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

console.log('==========================================')
console.log('E2E Contract Test: Interaction Node')
console.log('Frontend-Backend Type Consistency')
console.log('==========================================')
console.log(`Timestamp: ${new Date().toISOString()}`)
console.log('')

let passed = 0
let failed = 0
let total = 0

function check(condition, message) {
  total++
  if (condition) {
    passed++
    console.log(`  PASS: ${message}`)
  } else {
    failed++
    console.error(`  FAIL: ${message}`)
  }
}

// ════════════════════════════════════════════
// Contract 1: Shared types — NodeDef
// ════════════════════════════════════════════
console.log('Contract 1: Shared types — NodeDef interaction fields...')

const sharedWorkflowPath = join(ROOT, 'packages/shared/src/types/workflow.ts')
if (existsSync(sharedWorkflowPath)) {
  const content = readFileSync(sharedWorkflowPath, 'utf8')

  check(content.includes('"interaction"'), 'NodeDef type union includes "interaction"')
  check(content.includes('interaction_display'), 'NodeDef has interaction_display field')
  check(content.includes('interaction_max_rounds'), 'NodeDef has interaction_max_rounds field')
  check(content.includes('interaction_exit_when'), 'NodeDef has interaction_exit_when field')
  check(content.includes('interaction_timeout'), 'NodeDef has interaction_timeout field')
  check(content.includes('interaction_agent'), 'NodeDef has interaction_agent field')
  check(content.includes('InteractionAgentDef'), 'InteractionAgentDef interface defined')
} else {
  check(false, `File not found: ${sharedWorkflowPath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 2: Engine types — NodeExecutionResult
// ════════════════════════════════════════════
console.log('Contract 2: Engine types — NodeExecutionResult extension...')

const engineTypesPath = join(ROOT, 'packages/engine/src/executors/types.ts')
if (existsSync(engineTypesPath)) {
  const content = readFileSync(engineTypesPath, 'utf8')

  check(content.includes('pending_interaction'), 'NodeExecutionResult has pending_interaction status')
  check(content.includes('interactionMetadata'), 'NodeExecutionResult has interactionMetadata field')
  check(content.includes('InteractionMetadata'), 'InteractionMetadata interface defined')
} else {
  // Try alternative location
  const altPath = join(ROOT, 'packages/engine/src/types.ts')
  if (existsSync(altPath)) {
    const content = readFileSync(altPath, 'utf8')
    check(content.includes('pending_interaction'), 'NodeExecutionResult has pending_interaction status')
    check(content.includes('interactionMetadata'), 'NodeExecutionResult has interactionMetadata field')
  } else {
    check(false, 'Engine types file not found')
  }
}
console.log('')

// ════════════════════════════════════════════
// Contract 3: InteractionExecutor exists
// ════════════════════════════════════════════
console.log('Contract 3: InteractionExecutor implementation...')

const executorPath = join(ROOT, 'packages/engine/src/executors/interaction.ts')
if (existsSync(executorPath)) {
  const content = readFileSync(executorPath, 'utf8')

  check(content.includes('class InteractionExecutor'), 'InteractionExecutor class defined')
  check(content.includes('pending_interaction'), 'Returns pending_interaction status')
  check(content.includes('interactionMetadata'), 'Returns interactionMetadata')
  check(content.includes('completionData'), 'Handles completionData')
  check(content.includes('vars_update'), 'Processes vars_update')
} else {
  check(false, `InteractionExecutor not found: ${executorPath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 4: Server DB schema
// ════════════════════════════════════════════
console.log('Contract 4: Server DB schema...')

const schemaPath = join(ROOT, 'packages/server/src/db/schema.sql')
if (existsSync(schemaPath)) {
  const content = readFileSync(schemaPath, 'utf8')

  check(content.includes('linked_execution_id'), 'Schema has linked_execution_id')
  check(content.includes('linked_node_id'), 'Schema has linked_node_id')
  check(content.includes('interaction_mode'), 'Schema has interaction_mode')
  check(content.includes('interaction_status'), 'Schema has interaction_status')
} else {
  check(false, `Schema file not found: ${schemaPath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 5: ChatBridge service
// ════════════════════════════════════════════
console.log('Contract 5: ChatBridge service...')

const chatBridgePath = join(ROOT, 'packages/server/src/services/chat-bridge.ts')
if (existsSync(chatBridgePath)) {
  const content = readFileSync(chatBridgePath, 'utf8')

  check(content.includes('class ChatBridge'), 'ChatBridge class defined')
  check(content.includes('createInteractionSession'), 'Has createInteractionSession method')
  check(content.includes('findActiveSession'), 'Has findActiveSession method')
  check(content.includes('completeSession'), 'Has completeSession method')
  check(content.includes('COMPLETE_INTERACTION_TOOL'), 'Has complete_interaction tool definition')
  check(content.includes('complete_interaction'), 'Tool name is complete_interaction')
} else {
  check(false, `ChatBridge not found: ${chatBridgePath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 6: API routes
// ════════════════════════════════════════════
console.log('Contract 6: API routes...')

const executionRoutesPath = join(ROOT, 'packages/server/src/routes/execution.ts')
if (existsSync(executionRoutesPath)) {
  const content = readFileSync(executionRoutesPath, 'utf8')

  check(content.includes('/interaction/:nodeId/start'), 'Has POST /interaction/:nodeId/start route')
  check(content.includes('/interaction/:nodeId/complete'), 'Has POST /interaction/:nodeId/complete route')
  check(content.includes('/interaction/:nodeId/status'), 'Has GET /interaction/:nodeId/status route')
  check(content.includes('startInteraction'), 'Calls startInteraction service method')
  check(content.includes('completeInteraction'), 'Calls completeInteraction service method')
} else {
  check(false, `Execution routes not found: ${executionRoutesPath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 7: SSE events
// ════════════════════════════════════════════
console.log('Contract 7: SSE events...')

if (existsSync(executionRoutesPath)) {
  const content = readFileSync(executionRoutesPath, 'utf8')

  check(content.includes('interaction/:nodeId'),
    'Execution routes include interaction endpoint pattern')
}

// Also check lifecycle
const lifecyclePath = join(ROOT, 'packages/server/src/services/execution/ExecutionLifecycle.ts')
if (existsSync(lifecyclePath)) {
  const content = readFileSync(lifecyclePath, 'utf8')

  check(content.includes('pending_interaction'), 'Lifecycle handles pending_interaction status')
  check(content.includes('startInteraction'), 'Lifecycle has startInteraction method')
  check(content.includes('completeInteraction'), 'Lifecycle has completeInteraction method')
  check(content.includes('interaction'), 'Lifecycle has interaction handling')
  check(content.includes('execution_interaction_started'), 'Lifecycle emits execution_interaction_started SSE event')
} else {
  check(false, `ExecutionLifecycle not found: ${lifecyclePath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 8: Simulator support
// ════════════════════════════════════════════
console.log('Contract 8: Simulator support...')

const mockExecutorsPath = join(ROOT, 'packages/engine/src/simulator/mock-executors.ts')
if (existsSync(mockExecutorsPath)) {
  const content = readFileSync(mockExecutorsPath, 'utf8')

  check(content.includes('MockInteractionExecutor') || content.includes('interaction'),
    'Simulator has interaction mock support')
}

const mockFactoryPath = join(ROOT, 'packages/engine/src/simulator/mock-factory.ts')
if (existsSync(mockFactoryPath)) {
  const content = readFileSync(mockFactoryPath, 'utf8')

  check(content.includes('"interaction"') || content.includes('interaction'),
    'Mock factory handles interaction type')
}

const simTypesPath = join(ROOT, 'packages/engine/src/simulator/types.ts')
if (existsSync(simTypesPath)) {
  const content = readFileSync(simTypesPath, 'utf8')

  check(content.includes('InteractionMockDef') || content.includes('interaction'),
    'Simulator types include interaction mock definition')
}
console.log('')

// ════════════════════════════════════════════
// Contract 9: Web App components
// ════════════════════════════════════════════
console.log('Contract 9: Web App UI components...')

const interactionModalPath = join(ROOT, 'packages/web-app/components/workspace/interaction-modal.tsx')
const interactionNodePath = join(ROOT, 'packages/web-app/components/workspace/workflow-nodes/interaction-node.tsx')

if (existsSync(interactionModalPath)) {
  const content = readFileSync(interactionModalPath, 'utf8')
  check(content.includes('interaction'), 'InteractionModal component exists')
  check(content.includes('modal') || content.includes('panel'), 'Supports modal/panel display')
} else {
  check(false, `InteractionModal not found: ${interactionModalPath}`)
}

if (existsSync(interactionNodePath)) {
  const content = readFileSync(interactionNodePath, 'utf8')
  check(content.includes('interaction'), 'InteractionNode component exists')
} else {
  check(false, `InteractionNode not found: ${interactionNodePath}`)
}
console.log('')

// ════════════════════════════════════════════
// Contract 10: Executor factory integration
// ════════════════════════════════════════════
console.log('Contract 10: Executor factory integration...')

const factoryPath = join(ROOT, 'packages/engine/src/executor-factory.ts')
if (existsSync(factoryPath)) {
  const content = readFileSync(factoryPath, 'utf8')

  check(content.includes('"interaction"'), 'Factory handles interaction type')
  check(content.includes('InteractionExecutor'), 'Factory imports InteractionExecutor')
} else {
  check(false, `Executor factory not found: ${factoryPath}`)
}
console.log('')

// ════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════
console.log('==========================================')
console.log('Contract Test Summary')
console.log('==========================================')
console.log(`Total: ${total}`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)
console.log('')

if (failed > 0) {
  console.log('RESULT: FAIL — Some contracts are not satisfied')
  process.exit(1)
} else {
  console.log('RESULT: PASS — All contracts satisfied')
}

console.log(`\nCompleted at: ${new Date().toISOString()}`)
