# DevOps Skill Template

## Overview [REQUIRED]
Describe the infrastructure/operations scenario this Skill handles.
Include trigger conditions — when should the Agent use this Skill?

## Prerequisites [REQUIRED]
Required tools, access, and pre-conditions before execution.
<!-- Environment variables will be injected here if selected -->

## MCP Tools [OPTIONAL]
Available MCP tools for this operations scenario.
<!-- MCP configurations will be injected here if selected -->

## Pre-check [REQUIRED]
Validation steps before execution starts.
- Environment readiness check
- Permission verification
- Resource availability check

## Execution Plan [REQUIRED]
### Step 1: {Step Name}
- Action: What to execute
- Expected result: What success looks like

### Step 2: {Step Name}
- Action: What to execute
- Expected result: What success looks like

### Step 3: {Step Name}
- Action: What to execute
- Expected result: What success looks like

## Rollback Plan [REQUIRED]
Steps to undo changes if execution fails partway through.

## Verification [OPTIONAL]
Post-execution verification checklist.
- [ ] {verification criterion 1}
- [ ] {verification criterion 2}

## Knowledge Sources [OPTIONAL]
<!-- - {project} ({group}/{name}) — {what was referenced} -->
<!-- 源码定位: ~/.octopus/repos/index.md | 不可达 → index.md存在: repos clone | 不存在: 请用户告知路径或替代信息 -->

## Version History
- v1.0.0 ({date}): Initial release