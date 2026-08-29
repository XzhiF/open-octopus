# T7 — copy fixes: builtin-clones persona + task-author SKILL.md

## Status: done

## Depends on: none

## Scope

### 7.1 builtin-clones.ts:174

File: `packages/server/src/services/agent/builtin-clones.ts`

Change line 174:
```
- 旧: - WHAT 与 HOW 分离：你只产 task_spec（WHAT），workflow_ref 选择是 HOW，由用户/scheduler 决定
+ 新: - WHAT 与 HOW 分离：你只产 task_spec（WHAT），workflow_ref 由 task-author HOW-handoff 推荐，用户确认绑定
```

### 7.2 task-author SKILL.md HOW-handoff step 2

File: `packages/core-pack/skills/task-author/SKILL.md`

In the HOW-handoff section (around "步骤 2: 推荐 + 用户确认"), add instruction:
```
- 按 workflow-presets.yaml 过滤（task.skill_groups 命中 + 空 skills_group 兜底），给出 1-3 候选+理由。
- 无命中 → 退化为全量内置列表。
```

This ensures the agent's recommendation is grounded in the preset catalog, not LLM guesswork.

## Tests

No automated tests needed — these are text changes. Verify by reading the files.

## Verification

```bash
grep "HOW-handoff 推荐" packages/server/src/services/agent/builtin-clones.ts
grep "workflow-presets.yaml" packages/core-pack/skills/task-author/SKILL.md
```
