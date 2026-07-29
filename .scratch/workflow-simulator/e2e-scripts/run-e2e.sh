#!/usr/bin/env bash
# E2E test: Workflow Simulator CLI
# Usage: bash run-e2e.sh [--json-only | --verbose-only | --all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="node packages/cli/dist/index.js"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo -e "${GREEN}  ✔ $label (exit=$actual)${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}  ✖ $label (expected exit=$expected, got=$actual)${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local label="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "${GREEN}  ✔ $label${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}  ✖ $label (output missing: '$needle')${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_valid_json() {
  local label="$1" output="$2"
  TOTAL=$((TOTAL + 1))
  if echo "$output" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})" 2>/dev/null; then
    echo -e "${GREEN}  ✔ $label${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}  ✖ $label (invalid JSON)${NC}"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup fixtures ──────────────────────────────────────────────

WORKFLOW=$(mktemp /tmp/sim-e2e-XXXX.yaml)
FIXTURE=$(mktemp /tmp/sim-e2e-XXXX.test.yaml)
BAD_WF=$(mktemp /tmp/sim-e2e-bad-XXXX.yaml)
BAD_FIXTURE=$(mktemp /tmp/sim-e2e-bad-XXXX.test.yaml)

trap "rm -f $WORKFLOW $FIXTURE $BAD_WF $BAD_FIXTURE" EXIT

cat > "$WORKFLOW" <<'YAML'
apiVersion: octopus/v1
kind: Workflow
name: e2e-test-workflow
execution_mode: serial
nodes:
  - id: agent-greet
    type: agent
    prompt: "Say hello to $vars.user_name"
    outputs:
      greeting: "$last_output"
  - id: condition-check
    type: condition
    depends_on: [agent-greet]
    cases:
      - when: "$vars.greeting == 'hello Alice'"
        then: "bash-report"
      - when: "default"
        then: "bash-fallback"
  - id: bash-report
    type: bash
    bash: "echo 'Report: $vars.greeting'"
    depends_on: [condition-check]
  - id: bash-fallback
    type: bash
    bash: "echo 'No greeting'"
    depends_on: [condition-check]
YAML

cat > "$FIXTURE" <<'YAML'
scenarios:
  - name: "happy path"
    inputs:
      user_name: "Alice"
    mocks:
      agent-greet:
        output: "hello Alice"
        outputs:
          greeting: "hello Alice"
      bash-report:
        output: "Report: hello Alice"
      bash-fallback:
        output: "No greeting"
    assertions:
      status: completed
      vars:
        greeting: "hello Alice"
      node_trace:
        executed: [agent-greet, condition-check, bash-report]
        skipped: [bash-fallback]
      node_outputs:
        bash-report:
          output: "Report: hello Alice"
  - name: "fallback path"
    inputs:
      user_name: "Bob"
    mocks:
      agent-greet:
        output: "hi Bob"
        outputs:
          greeting: "hi Bob"
      bash-report:
        output: "Report: hi Bob"
      bash-fallback:
        output: "No greeting"
    assertions:
      status: completed
      node_trace:
        executed: [agent-greet, condition-check, bash-fallback]
        skipped: [bash-report]
YAML

cat > "$BAD_WF" <<'YAML'
apiVersion: octopus/v1
kind: Workflow
name: bad-syntax-test
nodes:
  - id: bash-bad
    type: bash
    bash: "if [ ; then fi"
  - id: agent-ok
    type: agent
YAML

cat > "$BAD_FIXTURE" <<'YAML'
scenarios:
  - name: "syntax error detected"
    mocks:
      bash-bad:
        output: "won't reach"
      agent-ok:
        output: "ok"
    assertions:
      status: completed
YAML

# ── Tests ────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Workflow Simulator — E2E Test Suite"
echo "══════════════════════════════════════════════════════"
echo ""

# AC-2 + AC-3: verbose mode runs all scenarios with per-node trace
echo "TEST: --verbose mode (AC-2 + AC-3)"
OUTPUT=$($CLI workflow simulate "$WORKFLOW" --verbose 2>&1) || true
RC=$?
assert_exit_code "passes all scenarios" 0 "$RC"
assert_output_contains "shows 'happy path'" "happy path" "$OUTPUT"
assert_output_contains "shows 'fallback path'" "fallback path" "$OUTPUT"
assert_output_contains "shows per-node trace (agent-greet)" "agent-greet" "$OUTPUT"
assert_output_contains "shows per-node trace (condition-check)" "condition-check" "$OUTPUT"
assert_output_contains "shows skipped nodes" "skipped" "$OUTPUT"
echo ""

# AC-4: JSON output is valid JSON with correct structure
echo "TEST: --json mode (AC-4)"
JSON_OUTPUT=$($CLI workflow simulate "$WORKFLOW" --json 2>&1) || true
assert_valid_json "output is valid JSON" "$JSON_OUTPUT"
assert_output_contains "contains results array" '"results"' "$JSON_OUTPUT"
assert_output_contains "contains passed field" '"passed": true' "$JSON_OUTPUT"
assert_output_contains "contains executionTrace" "executionTrace" "$JSON_OUTPUT"
assert_output_contains "contains assertionReport" "assertionReport" "$JSON_OUTPUT"
echo ""

# AC-5: --scenario filter
echo "TEST: --scenario filter (AC-5)"
FILTER_OUTPUT=$($CLI workflow simulate "$WORKFLOW" --scenario "happy path" 2>&1) || true
assert_output_contains "runs only named scenario" "1 passed" "$FILTER_OUTPUT"
assert_output_contains "happy path present" "happy path" "$FILTER_OUTPUT"
if echo "$FILTER_OUTPUT" | grep -q "fallback path"; then
  TOTAL=$((TOTAL + 1))
  FAIL=$((FAIL + 1))
  echo -e "${RED}  ✖ 'fallback path' should NOT appear when filtered${NC}"
else
  TOTAL=$((TOTAL + 1))
  PASS=$((PASS + 1))
  echo -e "${GREEN}  ✔ 'fallback path' correctly excluded by filter${NC}"
fi
echo ""

# AC-6: syntax pre-check
echo "TEST: syntax pre-check (AC-6)"
SYNTAX_JSON=$($CLI workflow simulate "$BAD_WF" --json 2>&1) || true
assert_valid_json "bad-syntax JSON is valid" "$SYNTAX_JSON"
assert_output_contains "syntaxErrors field present" "syntaxErrors" "$SYNTAX_JSON"
assert_output_contains "detects bash-bad node" "bash-bad" "$SYNTAX_JSON"
assert_output_contains "reports syntax error detail" "syntax error" "$SYNTAX_JSON"
echo ""

# AC-7: exit codes
echo "TEST: exit codes (AC-7)"
$CLI workflow simulate "$WORKFLOW" > /dev/null 2>&1
assert_exit_code "exit 0 on all pass" 0 "$?"

# Create a failing fixture
FAIL_FIXTURE=$(mktemp /tmp/sim-e2e-fail-XXXX.test.yaml)
cat > "$FAIL_FIXTURE" <<'YAML'
scenarios:
  - name: "will fail"
    mocks:
      agent-greet:
        output: "x"
      bash-report:
        output: "x"
      bash-fallback:
        output: "x"
    assertions:
      status: failed
YAML
FAIL_WF=$(mktemp /tmp/sim-e2e-fail-XXXX.yaml)
cp "$WORKFLOW" "$FAIL_WF"
set +e
$CLI workflow simulate "$FAIL_WF" > /dev/null 2>&1
FAIL_RC=$?
set -e
assert_exit_code "exit non-zero on assertion failure" 1 "$FAIL_RC"
rm -f "$FAIL_FIXTURE" "$FAIL_WF"
echo ""

# ── Summary ──────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✔ ALL $TOTAL CHECKS PASSED${NC}"
else
  echo -e "  ${RED}✖ $FAIL/$TOTAL CHECKS FAILED${NC} (${GREEN}$PASS passed${NC})"
fi
echo "══════════════════════════════════════════════════════"
echo ""
exit $FAIL
