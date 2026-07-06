/**
 * Exact replication of what Pi SDK sends to dashscope.
 * Tests if structured user message format triggers Claude identity.
 */
const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) { console.error('DASHSCOPE_API_KEY not set'); process.exit(1) }

const PI_SYSTEM_PROMPT_FULL = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files

Current date: 2026-07-06
Current working directory: C:/xzf/ai/open-octopus/packages/providers`

const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] }, strict: false } },
  { type: 'function', function: { name: 'bash', description: 'Execute bash commands (ls, grep, find, etc.)', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' } }, required: ['command'] }, strict: false } },
  { type: 'function', function: { name: 'edit', description: 'Make precise file edits with exact text replacement', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] }, strict: false } },
  { type: 'function', function: { name: 'write', description: 'Create or overwrite files', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, strict: false } },
]

async function test(messages, label) {
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'qwen3.7-plus', messages, tools: TOOLS, max_tokens: 200, stream: false }),
  })
  const data = await res.json()
  const answer = data.choices?.[0]?.message?.content ?? JSON.stringify(data.error || data)
  console.log(`\n[${label}]`); console.log(`Answer: ${answer}`)
}

// Test 1: System prompt only (no tools)
await test([
  { role: 'system', content: PI_SYSTEM_PROMPT_FULL },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Full prompt, no tools')

// Test 2: Short prompt + tools (returned Qwen before)
const SHORT_PROMPT = 'You are an expert coding assistant operating inside pi, a coding agent harness.'
await test([
  { role: 'system', content: SHORT_PROMPT },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Short prompt + tools')

// Test 3: Full prompt + tools
await test([
  { role: 'system', content: PI_SYSTEM_PROMPT_FULL },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Full prompt + tools')

// Test 4: Guidelines only (no tools, no pi docs)
const GUIDELINES_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Be concise in your responses
- Show file paths clearly when working with files`

await test([
  { role: 'system', content: GUIDELINES_PROMPT },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Guidelines prompt, no tools')

// Test 5: Tools + tool descriptions in prompt
const TOOLS_IN_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files`

await test([
  { role: 'system', content: TOOLS_IN_PROMPT },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Tools in prompt, no API tools')

// Test 6: Tools in prompt + API tools
await test([
  { role: 'system', content: TOOLS_IN_PROMPT },
  { role: 'user', content: 'Who are you? Answer in one sentence.' },
], 'Tools in prompt + API tools')
