/**
 * Intercept Pi SDK's actual API request to see tool definitions and messages.
 * Then replay the same request directly to compare.
 */

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) { console.error('DASHSCOPE_API_KEY not set'); process.exit(1) }

// Monkey-patch fetch to capture the exact request
const originalFetch = globalThis.fetch
let capturedPayload = null

globalThis.fetch = async (url, options) => {
  const urlStr = typeof url === 'string' ? url : url.toString()
  if (urlStr.includes('dashscope') && options?.body) {
    capturedPayload = JSON.parse(options.body)
  }
  return originalFetch(url, options)
}

// Run Pi SDK
import { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent'

const cwd = process.cwd()
const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

modelRegistry.registerProvider('dashscope', {
  name: 'DashScope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  api: 'openai-completions',
  apiKey,
  models: [
    { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
  ],
})

const model = modelRegistry.find('dashscope', 'qwen3.7-plus')
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: `${cwd}/.pi-agent`,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
})

const result = await createAgentSession({ cwd, modelRegistry, resourceLoader, model })
const session = result.session ?? result

// Subscribe to capture events
const events = []
session.subscribe((event) => {
  events.push(event)
})

console.log('>>> Running Pi SDK session...\n')
try {
  await session.prompt('Run this command: echo "test123"')
} catch (err) {
  console.error('Error:', err.message)
}

session.dispose()

// Now dump the captured request
if (!capturedPayload) {
  console.error('No API request captured!')
  process.exit(1)
}

console.log('\n=== CAPTURED PI SDK REQUEST ===')
console.log('\n--- Tools ---')
for (const tool of capturedPayload.tools || []) {
  console.log(`  ${tool.function?.name}: ${JSON.stringify(tool.function?.parameters)}`)
}
console.log(`\n--- Messages (${capturedPayload.messages?.length}) ---`)
for (const msg of capturedPayload.messages || []) {
  if (msg.role === 'system') {
    console.log(`  [system]: ${msg.content?.substring(0, 150)}...`)
  } else if (msg.role === 'user') {
    console.log(`  [user]: ${JSON.stringify(msg.content)?.substring(0, 200)}`)
  } else {
    console.log(`  [${msg.role}]: ${JSON.stringify(msg)?.substring(0, 200)}`)
  }
}
console.log(`\n--- Other params ---`)
console.log(`  model: ${capturedPayload.model}`)
console.log(`  stream: ${capturedPayload.stream}`)
console.log(`  max_tokens: ${capturedPayload.max_tokens ?? capturedPayload.max_completion_tokens}`)
console.log(`  stream_options: ${JSON.stringify(capturedPayload.stream_options)}`)

// Check all tool call events
console.log('\n--- Tool events from session ---')
for (const e of events) {
  if (e.type === 'tool_start' || e.type === 'tool_input' || e.type === 'tool_result') {
    console.log(`  ${e.type}: ${JSON.stringify(e).substring(0, 200)}`)
  }
}

// Now replay the exact same request directly (non-streaming)
console.log('\n\n=== DIRECT REPLAY (non-streaming) ===')
const directPayload = { ...capturedPayload, stream: false }
delete directPayload.stream_options
const res = await originalFetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  body: JSON.stringify(directPayload),
})
const data = await res.json()
const choice = data.choices?.[0]?.message
console.log(`Content: ${choice?.content?.substring(0, 150) ?? '(none)'}`)
console.log(`Tool calls: ${JSON.stringify(choice?.tool_calls ?? [])}`)
if (data.error) console.log(`Error: ${JSON.stringify(data.error)}`)
