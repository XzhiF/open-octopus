#!/bin/bash
# T2 — CLI validate/simulate for AC5(planning+warnings) / AC7(simulator)
# Uses REPO CLI (node packages/cli/dist/index.js) — global octopus on PATH is stale.
cd /Users/xzf/Projects/ai/XzhiF/open-octopus
CLI="node packages/cli/dist/index.js"
D=.scratch/goal-task-dev/e2e-data
LOG=$D/T2-cli.log
: > "$LOG"
fails=0

note() { echo "$@" | tee -a "$LOG"; }

check() { # name, cond, detail
  if [ "$2" = "0" ]; then note "PASS [$1] $3"; else note "FAIL [$1] $3"; fails=$((fails+1)); fi
}

# ── AC5a: planning top-level → reject with migration text ──
out=$($CLI workflow validate "$D/fix-planning.yaml" 2>&1); rc=$?
echo "$out" >> "$LOG"
[ $rc -ne 0 ]; check AC5a-planning-rejected $? "exit=$rc"
echo "$out" | grep -q "planning 已废弃"; check AC5a-migration-text $? "contains 'planning 已废弃'"

# ── AC5b: planning nested in loop → recursion pre-scan catches it ──
out=$($CLI workflow validate "$D/fix-planning-loop.yaml" 2>&1); rc=$?
echo "$out" >> "$LOG"
[ $rc -ne 0 ]; check AC5b-loop-planning-rejected $? "exit=$rc"
echo "$out" | grep -q "planning 已废弃"; check AC5b-loop-migration-text $? "contains 'planning 已废弃'"

# ── AC5c: engine pi + claude-only fields → validate PASSES with warnings ──
out=$($CLI workflow validate "$D/fix-pi-warning.yaml" 2>&1); rc=$?
echo "$out" >> "$LOG"
[ $rc -eq 0 ]; check AC5c-pi-not-rejected $? "exit=$rc"
echo "$out" | grep -qiE "warning|警告|不支持|max_turns"; check AC5c-warning-printed $? "warnings surfaced in CLI output"

# ── real-yaml validate (3 yamls per handoff-7) ──
# NOTE: xzf-dev carries a PRE-EXISTING host.prompt swarm validation error at HEAD
# (documented in ticket 04 Verification, out of this feature's scope) → informational only.
for y in task-dev superpowers-task-dev; do
  out=$($CLI workflow validate packages/core-pack/workflows/$y.yaml 2>&1); rc=$?
  echo "$out" >> "$LOG"
  [ $rc -eq 0 ]; check VAL-$y $? "exit=$rc"
done
out=$($CLI workflow validate packages/core-pack/workflows/xzf-dev.yaml 2>&1); rc=$?
echo "$out" >> "$LOG"
if [ $rc -ne 0 ] && echo "$out" | grep -qi "host.prompt\|assessment"; then
  note "INFO [VAL-xzf-dev] pre-existing baseline failure (swarm host.prompt), NOT counted"
elif [ $rc -eq 0 ]; then
  note "PASS [VAL-xzf-dev] (clean)"
else
  note "FAIL [VAL-xzf-dev] unexpected: exit=$rc"; fails=$((fails+1))
fi

# ── AC7: simulator — task-dev 2 scenarios (happy + max_turns exhausted) ──
out=$($CLI workflow simulate packages/core-pack/workflows/task-dev.yaml 2>&1); rc=$?
echo "$out" >> "$LOG"
[ $rc -eq 0 ]; check SIM-task-dev $? "exit=$rc"
echo "$out" | grep -q "2 passed, 0 failed"; check SIM-task-dev-2scenarios $? "2 passed"
echo "$out" | grep -q "goal_not_met (max_turns)"; check SIM-task-dev-exhausted-evidence $? "exhausted scenario asserts goal_not_met (max_turns)"

# ── AC7: superpowers cr-fix goal-ized ──
out=$($CLI workflow simulate packages/core-pack/workflows/superpowers-task-dev.yaml 2>&1); rc=$?
echo "$out" >> "$LOG"
[ $rc -eq 0 ]; check SIM-superpowers $? "exit=$rc"
echo "$out" | grep -q "2 passed, 0 failed"; check SIM-superpowers-2scenarios $? "2 passed"

note ""
note "=== T2 RESULT: fails=$fails ==="
exit $fails
