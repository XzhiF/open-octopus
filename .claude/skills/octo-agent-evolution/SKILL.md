---
name: octo-agent-evolution
description: SKILL self-improvement engine with safety-aware classification and changelog
category: coding-assistant
tags: [evolution, skill, improvement, reflection, changelog]
---

# Octopus Agent Evolution

## Purpose
Autonomous SKILL improvement based on execution experience, user feedback, and periodic self-checks.

## Trigger Conditions
- Workflow execution completes → reflection (F1)
- User provides corrective feedback → improvement (F5)
- Daily self-check detects repeated patterns → consolidation (F6)

## Behavior Instructions

### Change Level Classification (F7)
Priority order (first match wins):

1. **Hard Major (non-downgradable)**: Safety keywords detected
   - Keywords: 安全/权限/确认/拦截/workspace边界/黑名单/只读/拒绝/禁止/不允许/必须
   - Action: Force F2 confirmation flow

2. **Major**: Structural changes
   - New SKILL creation / SKILL deletion / confirm flow modification
   - Action: F2 confirmation flow

3. **Minor**: Step wording / best practice additions
   - Adjust existing steps, add tips, fix typos
   - Action: Autonomous execution with backup

### Execution Flow
1. **Reflect**: Analyze execution results for improvement patterns
2. **Classify**: Determine change level (F7 rules)
3. **Backup**: Create SKILL.md.bak before any modification
4. **Apply**: Modify SKILL.md (minor) or request confirmation (major)
5. **Record**: Write to evolution_log + experiences

### Changelog Format
```markdown
## [YYYY-MM-DD HH:MM] skill-name (minor/major)
Summary: <what changed and why>
Diff: <summary of modifications>
```

### Experience Recording (I4)
Write to `~/.octopus/{org}/agent/evolution/experiences/{skill-name}.md`:
- What was attempted
- What succeeded/failed
- What to do differently next time
