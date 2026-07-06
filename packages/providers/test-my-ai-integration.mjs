/**
 * Integration test: step-by-step Pi SDK provider registration for my-ai
 * Usage: MY_AI_API_KEY=xxx DASHSCOPE_API_KEY=xxx node test-my-ai-integration.mjs
 */
import { loadModelAliasConfig, resolveModelAlias } from '@octopus/shared'

const apiKey = process.env.MY_AI_API_KEY
const dashKey = process.env.DASHSCOPE_API_KEY

console.log('=== Step 1: Environment ===')
console.log(`MY_AI_API_KEY: ${apiKey ? `set (${apiKey.substring(0, 8)}...)` : 'NOT SET'}`)
console.log(`DASHSCOPE_API_KEY: ${dashKey ? `set (${dashKey.substring(0, 8)}...)` : 'NOT SET'}`)

if (!apiKey) { console.error('FATAL: MY_AI_API_KEY not set'); process.exit(1) }

console.log('\n=== Step 2: Load models.yaml ===')
const config = loadModelAliasConfig()
const cp = config.custom_providers?.['my-ai']
if (!cp) { console.error('FATAL: my-ai not in custom_providers'); process.exit(1) }
console.log(`base_url: ${cp.base_url}`)
console.log(`env_key: ${cp.env_key ?? '(default: MY_AI_API_KEY)'}`)
console.log(`models: ${cp.models.map(m => m.id).join(', ')}`)
console.log(`api: ${cp.api ?? 'openai-completions'}`)

console.log('\n=== Step 3: Tier resolution ===')
console.log(`pro-max → ${resolveModelAlias('pro-max', 'pi', config)}`)

console.log('\n=== Step 4: Import Pi SDK ===')
const pi = await import('@earendil-works/pi-coding-agent')
const authStorage = pi.AuthStorage.inMemory()
const modelRegistry = pi.ModelRegistry.inMemory(authStorage)

console.log('\n=== Step 5: Register providers ===')

// Register dashscope (built-in with extra config)
if (dashKey) {
  try {
    modelRegistry.registerProvider('dashscope', {
      name: 'DashScope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api: 'openai-completions',
      apiKey: dashKey,
      models: [
        { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
      ],
    })
    console.log(`  dashscope: REGISTERED`)
  } catch (err) { console.log(`  dashscope: FAILED — ${err.message}`) }
}

// Register my-ai (custom provider from YAML)
const envKey = cp.env_key ?? 'MY_AI_API_KEY'
const resolvedKey = process.env[envKey]
console.log(`  my-ai env_key="${envKey}" → ${resolvedKey ? `found (${resolvedKey.substring(0, 8)}...)` : 'NOT FOUND'}`)

if (resolvedKey) {
  const api = cp.api ?? 'openai-completions'
  const providerConfig = {
    name: 'my-ai',
    baseUrl: cp.base_url,
    api,
    apiKey: resolvedKey,
    models: cp.models.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      api,
      reasoning: m.reasoning ?? false,
      input: ['text'],
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
      contextWindow: m.context_window ?? 32768,
      maxTokens: m.max_tokens ?? 8192,
    })),
  }
  console.log(`  my-ai config: ${JSON.stringify({ name: providerConfig.name, baseUrl: providerConfig.baseUrl, api: providerConfig.api, modelCount: providerConfig.models.length })}`)

  try {
    modelRegistry.registerProvider('my-ai', providerConfig)
    console.log(`  my-ai: REGISTERED ✅`)
  } catch (err) {
    console.log(`  my-ai: FAILED ❌ — ${err.message}`)
    console.log(`  Stack: ${err.stack?.split('\n').slice(0, 3).join('\n')}`)
  }
}

console.log('\n=== Step 6: Model lookup ===')
const model = modelRegistry.find('my-ai', 'glm-5.2')
console.log(`find('my-ai', 'glm-5.2'): ${model ? `${model.provider}/${model.id} ✅` : 'NOT FOUND ❌'}`)
if (model) {
  console.log(`  baseUrl: ${model.baseUrl}`)
  console.log(`  contextWindow: ${model.contextWindow}`)
  console.log(`  maxTokens: ${model.maxTokens}`)
}

// List all if possible
try {
  const all = modelRegistry.getAll()
  console.log(`\nAll registered models (${all.length}):`)
  for (const m of all) console.log(`  ${m.provider}/${m.id}`)
} catch { console.log('  (getAll not available)') }

// List providers
try {
  const providers = modelRegistry.listProviders()
  console.log(`\nRegistered providers: ${providers.join(', ')}`)
} catch { console.log('  (listProviders not available)') }
