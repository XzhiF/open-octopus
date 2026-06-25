# Troubleshooting Skill Template

## Overview [REQUIRED]
Describe the symptoms this Skill helps diagnose and resolve.
Include trigger conditions — when should the Agent use this Skill?

## Prerequisites [REQUIRED]
List required tools, access, and environment before starting troubleshooting.
<!-- Environment variables will be injected here if selected -->

## MCP Tools [OPTIONAL]
List MCP tools available for this troubleshooting scenario.
<!-- MCP configurations will be injected here if selected -->

## Investigation Steps [REQUIRED]
### Step 1: Identify the Problem
- How to recognize the specific error state
- Key indicators and symptoms to check

### Step 2: Collect Information
- Commands and tools to gather diagnostic data
- Logs, metrics, and events to examine

### Step 3: Analyze Root Cause
- Decision tree for common causes
- How to narrow down the root cause

### Step 4: Apply Solution
- Remediation steps per identified cause
- Verification steps after fix

## Common Causes [OPTIONAL]
| Symptom | Likely Cause | Quick Fix |
|---------|-------------|-----------|
| {symptom} | {cause} | {fix} |

## Knowledge Sources [OPTIONAL]
<!-- - {project} ({group}/{name}) — {what was referenced} -->
<!-- 源码定位: ~/.octopus/repos/index.md | 不可达 → index.md存在: repos clone | 不存在: 请用户告知路径或替代信息 -->

## Escalation [REQUIRED]
- When to escalate and who to contact
- Conditions that require human intervention
- Production-specific escalation rules

## Version History
- v1.0.0 ({date}): Initial release