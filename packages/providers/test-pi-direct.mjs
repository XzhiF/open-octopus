/**
 * Direct API test — bypasses Pi SDK entirely.
 * Tests what qwen says when given Pi SDK's system prompt vs no system prompt.
 *
 * Usage: node test-pi-direct.mjs
 */

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) {
  console.error('DASHSCOPE_API_KEY not set')
  process.exit(1)
}

const PI_SYSTEM_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`

const question = 'Who are you? What model are you? Answer in one sentence.'

async function ask(systemPrompt, label) {
  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: question })

  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'qwen3.7-plus',
      messages,
      max_tokens: 200,
    }),
  })

  const data = await res.json()
  const answer = data.choices?.[0]?.message?.content ?? JSON.stringify(data)
  console.log(`\n[${label}]`)
  console.log(`System: ${systemPrompt ? systemPrompt.substring(0, 80) + '...' : '(none)'}`)
  console.log(`Answer: ${answer}`)
}

// Test 1: No system prompt
await ask(null, 'No system prompt')

// Test 2: Pi SDK system prompt
await ask(PI_SYSTEM_PROMPT, 'Pi SDK system prompt')

// Test 3: Explicit identity
await ask('You are a Qwen AI model developed by Alibaba Cloud.', 'Explicit Qwen identity')

// Test 4: Pi SDK system prompt WITH tools (like Pi SDK actually sends)
async function askWithTools(systemPrompt, tools, label) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ]
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'qwen3.7-plus',
      messages,
      tools: tools.map(t => ({ type: 'function', function: t })),
      max_tokens: 200,
    }),
  })
  const data = await res.json()
  const answer = data.choices?.[0]?.message?.content ?? JSON.stringify(data)
  console.log(`\n[${label}]`)
  console.log(`Tools: ${tools.map(t => t.name).join(', ')}`)
  console.log(`Answer: ${answer}`)
}

const PI_TOOLS = [
  { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
  { name: 'bash', description: 'Execute bash commands (ls, grep, find, etc.)', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' } }, required: ['command'] } },
  { name: 'edit', description: 'Make precise file edits with exact text replacement', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] } },
  { name: 'write', description: 'Create or overwrite files', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
]

await askWithTools(PI_SYSTEM_PROMPT, PI_TOOLS, 'Pi SDK prompt + tools')
