---
name: octo-agent-scheduler
description: Scheduled agent job creation, execution, and report management
category: coding-assistant
tags: [scheduler, cron, periodic, agent-job, reports]
---

# Octopus Agent Scheduler

## Purpose
Create, manage, and execute scheduled agent jobs with memory-aware prompts and report generation.

## Trigger Conditions
- User requests a recurring task (intent: scheduled_task)
- Cron expression or natural language schedule provided

## Behavior Instructions

### Creating a Scheduled Job
1. Parse schedule: natural language → cron expression
2. Design agent prompt with memory-aware instructions
3. Configure report storage: `reports/{workflow-name}/{date}.md`
4. Set notification channel from config (hermes → telegram)

### Cron Expression Generation
- "每天10点" → `0 10 * * *`
- "每周一" → `0 9 * * 1`
- "每小时" → `0 * * * *`
- "工作日" → `0 9 * * 1-5`

### Agent Job Execution (E2)
When a scheduled job fires:
1. Assemble system prompt: persona + SKILL + memory + last report summary
2. Call Claude SDK with assembled prompt
3. Write execution result to `reports/{name}/{date}.md`
4. Send notification via hermes
5. Record result in work memory

### Report Storage Strategy
```
~/.octopus/{org}/agent/reports/
├── pr-summary/
│   ├── 2026-06-20.md
│   └── 2026-06-21.md
└── code-review/
    └── 2026-06-20.md
```

### Memory Integration
- Read last report to get continuation state (e.g., "last PR analyzed: #456")
- Write current report summary to work memory
- Update long-term memory if significant patterns emerge
