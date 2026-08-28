#!/bin/bash
# T1 — targeted unit verification for AC1/AC4/AC5/AC9(unit half)
# Runs the goal-task-dev feature's unit test files across 4 packages.
set -uo pipefail
cd /Users/xzf/Projects/ai/XzhiF/open-octopus
OUT=.scratch/goal-task-dev/e2e-data/T1-units.log
: > "$OUT"

run() {
  local label="$1"; shift
  echo "=== $label ===" | tee -a "$OUT"
  "$@" 2>&1 | tail -8 | tee -a "$OUT"
  echo "--- exit=${PIPESTATUS[0]:-?} for $label ---" | tee -a "$OUT"
}

# per-invocation exit capture
p() {
  local label="$1"; shift
  { "$@" > /tmp/t1-$$.log 2>&1; echo "$?"; } > /tmp/t1-exit-$$.tmp
  local code=$(cat /tmp/t1-exit-$$.tmp)
  echo "=== $label (exit=$code) ===" >> "$OUT"
  tail -6 /tmp/t1-$$.log >> "$OUT"
  grep -E "Test Files|Tests " /tmp/t1-$$.log >> "$OUT" || true
  rm -f /tmp/t1-$$.log /tmp/t1-exit-$$.tmp
  [ "$code" -eq 0 ] && echo "PASS [$label]" || echo "FAIL [$label]"
}

p "shared:goal-mode+planning(AC5)" pnpm --filter @octopus/shared exec vitest run src/__tests__/goal-mode.test.ts src/__tests__/task-spec-input-values.test.ts
p "providers:plumbing(AC4)"        pnpm --filter @octopus/providers exec vitest run src/__tests__/claude-goal-plumbing.test.ts
p "engine:adapter(AC1/AC3/AC4)"    pnpm --filter @octopus/engine exec vitest run src/__tests__/agent-goal-mode.test.ts src/__tests__/agent-goal-runner.test.ts
p "server:preset-migration(AC9)"   pnpm --filter @octopus/server exec vitest run src/services/agent/__tests__/clone-init-service.test.ts src/services/agent/__tests__/workflow-presets-seed.test.ts
p "webapp:workflow-box(fixF/N)"    pnpm --filter @octopus/web-app exec vitest run components/tasks/authoring/__tests__/workflow-box.test.tsx
