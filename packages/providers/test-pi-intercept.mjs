/**
 * Intercept Pi SDK's actual HTTP request to dashscope and log the payload.
 * Usage: node test-pi-intercept.mjs
 */

// Monkey-patch global fetch to intercept dashscope requests
const originalFetch = globalThis.fetch
let interceptedPayload = null

globalThis.fetch = async (url, options) => {
  const urlStr = typeof url === 'string' ? url : url.toString()
  if (urlStr.includes('dashscope') && options?.body) {
    interceptedPayload = JSON.parse(options.body)
    console.log('\n=== INTERCEPTED REQUEST ===')
    console.log('URL:', urlStr)
    console.log('Messages:')
    for (const msg of interceptedPayload.messages || []) {
      const content = typeof msg.content === 'string'
        ? msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : '')
        : JSON.stringify(msg.content)?.substring(0, 200)
      console.log(`  [${msg.role}]: ${content}`)
    }
    console.log('Tools:', (interceptedPayload.tools || []).map(t => t.function?.name).join(', ') || '(none)')
    console.log('Model:', interceptedPayload.model)
    console.log('=== END INTERCEPTED ===\n')
  }
  return originalFetch(url, options)
}

// Now run Pi SDK
import { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent'

const cwd = process.cwd()
const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) { console.error('DASHSCOPE_API_KEY not set'); process.exit(1) }

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
  cwd,
  agentDir: `${cwd}/.pi-agent`,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
})

const result = await createAgentSession({ cwd, modelRegistry, resourceLoader, model })
const session = result.session ?? result

const chunks = []
session.subscribe((event) => {
  if (event.type === 'text_delta') {
    chunks.push(event.content)
  }
})

console.log('>>> Asking: Who are you? What model?\n')
try {
  await session.prompt('Who are you? What model are you? Answer in one sentence.')
} catch (err) {
  console.error('Error:', err.message)
}

console.log('\n>>> Response:', chunks.join('') || '(empty)')
session.dispose()
