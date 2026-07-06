/**
 * Minimal Pi SDK test — bypasses Octopus engine entirely.
 * Directly creates a Pi SDK session and asks "who are you?"
 *
 * Usage: node test-pi-sdk.mjs
 */
import { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent'

const cwd = process.cwd()

// Minimal setup — same as our adapter
const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

// Register dashscope provider
const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) {
  console.error('DASHSCOPE_API_KEY not set')
  process.exit(1)
}

modelRegistry.registerProvider('dashscope', {
  name: 'DashScope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  api: 'openai-completions',
  apiKey,
  models: [
    { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
  ],
})

// Find the registered model
const model = modelRegistry.find('dashscope', 'qwen3.7-plus')
console.log('Model:', JSON.stringify(model, null, 2)?.substring(0, 500))
console.log('Model keys:', model ? Object.keys(model) : 'null')
console.log('All providers:', modelRegistry.listProviders?.() ?? 'N/A')
console.log('All models:', JSON.stringify(modelRegistry.listModels?.('dashscope') ?? 'N/A')?.substring(0, 500))

// Create resource loader with everything disabled (same as our adapter)
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: `${cwd}/.pi-agent`,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
})

// Create session — NO custom systemPrompt, let Pi SDK use its default
const result = await createAgentSession({
  cwd,
  modelRegistry,
  resourceLoader,
  model,
})

const session = result.session ?? result

// Print the actual system prompt being used
console.log('\n=== System Prompt (first 200 chars) ===')
const sp = session.systemPrompt ?? '(not accessible)'
console.log(typeof sp === 'string' ? sp.substring(0, 200) + '...' : sp)
console.log('=== End ===\n')

// Subscribe to events
const chunks = []
let thinkingBuf = []
session.subscribe((event) => {
  if (event.type === 'text_delta') {
    chunks.push(event.content)
    process.stdout.write(event.content)
  }
  if (event.type === 'thinking') {
    thinkingBuf.push(event.content)
  }
  if (event.type === 'thinking_start') {
    thinkingBuf = []
  }
  if (event.type === 'thinking_done') {
    console.error('[thinking]:', thinkingBuf.join(''))
  }
  if (event.type === 'error' || event.type === 'tool_result') {
    console.error(`[${event.type}]:`, JSON.stringify(event))
  }
})

// Ask the simplest question
console.log('>>> Asking: Who are you?\n')
try {
  await session.prompt('Who are you? What model are you? Answer in one sentence.')
} catch (err) {
  console.error('Prompt error:', err.message)
}

console.log('\n\n>>> Full response:')
console.log(chunks.join('') || '(empty)')

session.dispose()
