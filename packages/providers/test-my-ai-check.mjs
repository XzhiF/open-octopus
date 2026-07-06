/**
 * Minimal test: verify my-ai provider registration and API call.
 * Usage: DASHSCOPE_API_KEY=xxx MY_AI_API_KEY=yyy node test-my-ai-check.mjs
 */
import { loadModelAliasConfig, resolveModelAlias } from '@octopus/shared'

// 1. Check env vars
console.log('=== Environment Variables ===')
console.log(`DASHSCOPE_API_KEY: ${process.env.DASHSCOPE_API_KEY ? `set (${process.env.DASHSCOPE_API_KEY.substring(0, 8)}...)` : 'NOT SET'}`)
console.log(`MY_AI_API_KEY: ${process.env.MY_AI_API_KEY ? `set (${process.env.MY_AI_API_KEY.substring(0, 8)}...)` : 'NOT SET'}`)

// 2. Load models.yaml and check config
console.log('\n=== models.yaml ===')
const config = loadModelAliasConfig()
console.log(`pi.pro-max → ${resolveModelAlias('pro-max', 'pi', config)}`)
console.log(`pi.pro → ${resolveModelAlias('pro', 'pi', config)}`)
console.log(`custom_providers keys: ${Object.keys(config.custom_providers ?? {}).join(', ') || '(none)'}`)

// 3. Try creating a Pi SDK session with my-ai provider
console.log('\n=== Pi SDK Session Test ===')
const { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry } = await import('@earendil-works/pi-coding-agent')

const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

// Simulate what adapter does: register providers from env
const PROVIDER_ENV_KEYS = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  DASHSCOPE_API_KEY: 'dashscope',
  MY_AI_API_KEY: 'my-ai',
}

for (const [envKey, providerName] of Object.entries(PROVIDER_ENV_KEYS)) {
  const apiKey = process.env[envKey]
  if (!apiKey) {
    console.log(`  ${providerName}: SKIPPED (${envKey} not set)`)
    continue
  }

  if (providerName === 'my-ai') {
    // Custom provider — needs full config
    const cp = config.custom_providers?.['my-ai']
    if (!cp) {
      console.log(`  my-ai: SKIPPED (not in custom_providers)`)
      continue
    }
    try {
      modelRegistry.registerProvider('my-ai', {
        name: 'my-ai',
        baseUrl: cp.base_url,
        api: cp.api ?? 'openai-completions',
        apiKey,
        models: cp.models.map(m => ({
          id: m.id,
          name: m.name ?? m.id,
          api: cp.api ?? 'openai-completions',
          reasoning: m.reasoning ?? false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.context_window ?? 32768,
          maxTokens: m.max_tokens ?? 8192,
        })),
      })
      console.log(`  my-ai: REGISTERED (baseUrl: ${cp.base_url}, models: ${cp.models.map(m => m.id).join(', ')})`)
    } catch (err) {
      console.log(`  my-ai: FAILED (${err.message})`)
    }
  } else {
    // Built-in provider
    try {
      modelRegistry.registerProvider(providerName, { apiKey })
      console.log(`  ${providerName}: REGISTERED`)
    } catch (err) {
      console.log(`  ${providerName}: FAILED (${err.message})`)
    }
  }
}

// 4. Try to find the model
console.log('\n=== Model Resolution ===')
const model = modelRegistry.find('my-ai', 'glm-5.2')
if (model) {
  console.log(`Found: ${model.provider}/${model.id} (baseUrl: ${model.baseUrl})`)
} else {
  console.log('NOT FOUND: my-ai/glm-5.2')
}

const dashModel = modelRegistry.find('dashscope', 'qwen3.7-plus')
if (dashModel) {
  console.log(`Found: ${dashModel.provider}/${dashModel.id}`)
} else {
  console.log('NOT FOUND: dashscope/qwen3.7-plus')
}

// 5. Try a minimal API call
if (model) {
  console.log('\n=== API Call Test (my-ai/glm-5.2) ===')
  try {
    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey: process.env.MY_AI_API_KEY, baseURL: model.baseUrl })
    const res = await client.chat.completions.create({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'Say hello in 3 words' }],
      max_tokens: 50,
    })
    console.log(`Response: ${res.choices?.[0]?.message?.content ?? '(empty)'}`)
  } catch (err) {
    console.log(`ERROR: ${err.status ?? ''} ${err.message}`)
  }
}
