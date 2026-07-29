# Issue 2: System prompt `record_daily` tool definition + guidance

## Summary
Add `RECORD_DAILY_TOOLS_PROMPT` constant with tool definition and positive/negative examples, appended to the system prompt.

## Changes
1. `packages/server/src/routes/agent/main-agent-route.ts` — add `RECORD_DAILY_TOOLS_PROMPT` constant and append to system prompt

## Details
- Define `RECORD_DAILY_TOOLS_PROMPT` similar to `EVOLUTION_TOOLS_PROMPT`
- Include tool description: `record_daily` — record valuable insights to daily memory
- Include positive examples (user preferences, workflow patterns, important decisions)
- Include negative examples (simple greetings, factual Q&A, one-time lookups)
- Append to system prompt: `${baseSystemPrompt}\n\n${DELEGATION_TOOLS_PROMPT}\n\n${EVOLUTION_TOOLS_PROMPT}\n\n${RECORD_DAILY_TOOLS_PROMPT}`

## Verification Method
- Build: `pnpm build` succeeds
- Inspect: system prompt contains record_daily guidance when assembled
