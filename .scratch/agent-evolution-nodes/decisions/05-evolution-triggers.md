# 05 — Evolution Triggers

Type: grilling
Status: resolved

## Question
When and how does evolution get triggered?

## Answer
All 4 trigger modes supported:

1. **Failure threshold** — When a system_agent node's failure count exceeds a configurable threshold, auto-trigger evolution
2. **Workflow orchestration** — Explicit `evolution` blocks in YAML nodes, scheduled in the DAG
3. **Scheduled** — Cron-based periodic review via the scheduler clone
4. **Manual** — API endpoint `POST /api/agent/evolution/trigger` for on-demand evolution

**Reason**: Different scenarios need different triggers. Failures need reactive evolution; routine improvement needs scheduled evolution; developers need manual control.
