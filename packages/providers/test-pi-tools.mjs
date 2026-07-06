/**
 * Test tool calling with Pi SDK's exact tool definitions against dashscope API.
 * Intercepts the actual request to capture real tool schemas.
 *
 * Usage: node test-pi-tools.mjs
 */

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) { console.error('DASHSCOPE_API_KEY not set'); process.exit(1) }

// ─── Test 1: Direct API with simple tool definition ───
async function testDirect(label, tools, question) {
  const messages = [
    { role: 'system', content: 'You are a helpful coding assistant.' },
    { role: 'user', content: question },
  ]
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'qwen3.7-plus', messages, tools, max_tokens: 500, stream: false }),
  })
  const data = await res.json()
  const choice = data.choices?.[0]?.message
  console.log(`\n[${label}]`)
  console.log(`  Content: ${choice?.content?.substring(0, 100) ?? '(none)'}`)
  console.log(`  Tool calls: ${JSON.stringify(choice?.tool_calls ?? [])}`)
  if (data.error) console.log(`  Error: ${JSON.stringify(data.error)}`)
}

// Simple tool definition (standard OpenAI format)
const SIMPLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
        },
        required: ['command'],
      },
    },
  },
]

await testDirect('Simple tool schema', SIMPLE_TOOLS, 'Run: echo "hello world"')

// ─── Test 2: Pi SDK's exact tool definition (with strict: false) ───
const PI_STYLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 500 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' },
        },
        required: ['command'],
      },
      strict: false,
    },
  },
]

await testDirect('Pi-style tool (strict:false, long desc)', PI_STYLE_TOOLS, 'Run: echo "hello world"')

// ─── Test 3: All 4 Pi SDK tools ───
const ALL_PI_TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] }, strict: false } },
  { type: 'function', function: { name: 'bash', description: 'Execute a bash command in the current working directory. Returns stdout and stderr.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Bash command to execute' }, timeout: { type: 'number', description: 'Timeout in seconds' } }, required: ['command'] }, strict: false } },
  { type: 'function', function: { name: 'edit', description: 'Make precise file edits with exact text replacement', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } } }, required: ['path', 'edits'] }, strict: false } },
  { type: 'function', function: { name: 'write', description: 'Create or overwrite files', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] }, strict: false } },
]

await testDirect('All 4 Pi tools', ALL_PI_TOOLS, 'Run: echo "pi-agent works"')

// ─── Test 4: With Pi SDK system prompt + all tools ───
const PI_SYSTEM_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses`

const messages4 = [
  { role: 'system', content: PI_SYSTEM_PROMPT },
  { role: 'user', content: 'Run: echo "pi-agent works"' },
]
const res4 = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  body: JSON.stringify({ model: 'qwen3.7-plus', messages: messages4, tools: ALL_PI_TOOLS, max_tokens: 500, stream: false }),
})
const data4 = await res4.json()
const choice4 = data4.choices?.[0]?.message
console.log(`\n[Pi system prompt + all tools]`)
console.log(`  Content: ${choice4?.content?.substring(0, 150) ?? '(none)'}`)
console.log(`  Tool calls: ${JSON.stringify(choice4?.tool_calls ?? [])}`)
