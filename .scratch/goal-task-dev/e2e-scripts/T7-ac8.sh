#!/bin/bash
# T7 — AC8 static schema-cleanup verification (spec mapping: grep=0, no schema file, sync branch removed)
cd /Users/xzf/Projects/ai/XzhiF/open-octopus
LOG=.scratch/goal-task-dev/e2e-data/T7-ac8.log
: > "$LOG"
fails=0
note(){ echo "$@" | tee -a "$LOG"; }
chk(){ if [ "$2" = 0 ]; then note "PASS [$1] $3"; else note "FAIL [$1] $3"; fails=$((fails+1)); fi; }

# 1) spec-scope grep (AC8 verbatim scope)
n=$(grep -rn "yaml-language-server" packages/core-pack/workflows/ .claude/skills/octo-workflow-dev .claude/skills/octo-workflow-test packages/core-pack/skills/octo-workflow-dev packages/core-pack/skills/octo-workflow-test 2>/dev/null | grep -v ".scratch" | wc -l | tr -d ' ')
[ "$n" = "0" ]; chk AC8-grep-scope $? "hits=$n (expect 0)"

# 2) broader repo grep (excluding .scratch history)
n2=$(grep -rn "yaml-language-server" packages/ .claude/skills/ --include="*.yaml" --include="*.md" 2>/dev/null | grep -v ".scratch" | wc -l | tr -d ' ')
[ "$n2" = "0" ]; chk AC8-grep-broad $? "hits=$n2 (expect 0)"

# 3) orphan schema file gone
[ ! -f ~/.octopus/workflow-schema.json ]; chk AC8-no-orphan-schema $? "exists=$([ -f ~/.octopus/workflow-schema.json ] && echo yes || echo no)"
[ ! -f packages/core-pack/workflows/workflow-schema.json ]; chk AC8-no-corepack-schema $? ""

# 4) AC8 verbatim: "sync-builtin.mjs schema 分支与 :70 残留 log 移除, 跑 sync 不报错"
#    → script itself STAYS; must not mention schema; must run with exit 0.
[ -f scripts/sync-builtin.mjs ]; chk AC8-sync-builtin-exists $? ""
s=$(grep -ci "schema" scripts/sync-builtin.mjs)
[ "$s" = "0" ]; chk AC8-sync-builtin-no-schema-branch $? "schema mentions=$s (expect 0)"
node scripts/sync-builtin.mjs > /dev/null 2>&1; chk AC8-sync-builtin-runs-clean $? "exit=$?"
#    setup-runner: schema branch removed → only doc-comments may mention it, no code line.
g=$(grep -n "workflow-schema" packages/cli/src/setup-runner/index.ts | grep -vE ':[0-9]*\s*(//|\*|/\*)' | grep -vE '^[0-9]+:\s*(//|\*)' | wc -l | tr -d ' ')
[ "$g" = "0" ]; chk AC8-setup-runner-code-free $? "non-comment workflow-schema code lines=$g (expect 0)"

exit $fails
