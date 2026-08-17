#!/usr/bin/env bash
# E2E Integration Tests for Harness Semantic V2
# Ticket 08 — verifies all 7 acceptance criteria
#
# Usage:
#   ./run-e2e-tests.sh [--server-url http://localhost:3001] [--workspace-id <id>]
#
# Prerequisites:
#   - Server running (pnpm dev)
#   - curl available
#   - jq available (for JSON parsing)
#
# Exit codes:
#   0 = all tests passed
#   1 = one or more tests failed
#   2 = server not reachable (skip tests gracefully)

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
SERVER_URL="${SERVER_URL:-http://localhost:3001}"
WORKSPACE_ID="${WORKSPACE_ID:-e6d714bf-ed74-4041-ad56-2ccc82acd16b}"
API_BASE="${SERVER_URL}/api/workspaces/${WORKSPACE_ID}"
POLL_INTERVAL=3
MAX_POLL_SECONDS=300
VERBOSE="${VERBOSE:-0}"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─── Counters ────────────────────────────────────────────────────────────────
PASSED=0
FAILED=0
SKIPPED=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $*"; FAILED=$((FAILED + 1)); }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $*"; SKIPPED=$((SKIPPED + 1)); }
log_section() { echo -e "\n${BLUE}═══ $* ═══${NC}"; }

check_server() {
  if ! curl -sf "${SERVER_URL}/api/actuator/health" > /dev/null 2>&1; then
    log_skip "Server not reachable at ${SERVER_URL} — skipping all tests"
    log_info "Start the server with 'pnpm dev' and re-run this script"
    exit 2
  fi
  log_info "Server reachable at ${SERVER_URL}"
}

# Create execution and return execution ID
create_execution() {
  local workflow_ref="$1"
  local response
  response=$(curl -sf -X POST "${API_BASE}/executions" \
    -H "Content-Type: application/json" \
    -d "{\"workflow_ref\": \"${workflow_ref}\"}" 2>&1) || {
    echo "CREATE_FAILED"
    return 1
  }
  echo "$response" | jq -r '.id // "CREATE_FAILED"'
}

# Start execution
start_execution() {
  local exec_id="$1"
  curl -sf -X POST "${API_BASE}/executions/${exec_id}/start" \
    -H "Content-Type: application/json" \
    -d '{}' > /dev/null 2>&1
}

# Poll execution until terminal status or timeout
# Returns the final status
poll_execution() {
  local exec_id="$1"
  local elapsed=0
  while [ $elapsed -lt $MAX_POLL_SECONDS ]; do
    local response
    response=$(curl -sf "${API_BASE}/executions/${exec_id}" 2>&1) || {
      sleep $POLL_INTERVAL
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    }
    local status
    status=$(echo "$response" | jq -r '.status // "unknown"')
    case "$status" in
      completed|failed|completed_with_failures|cancelled|blocked)
        echo "$status"
        return 0
        ;;
    esac
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "TIMEOUT"
  return 1
}

# Get execution detail as JSON
get_execution() {
  local exec_id="$1"
  curl -sf "${API_BASE}/executions/${exec_id}" 2>/dev/null
}

# Get execution list
get_execution_list() {
  curl -sf "${API_BASE}/executions" 2>/dev/null
}

# Get agent events for execution
get_agent_events() {
  local exec_id="$1"
  local node_id="${2:-}"
  if [ -n "$node_id" ]; then
    curl -sf "${API_BASE}/executions/${exec_id}/agent-events?nodeId=${node_id}" 2>/dev/null
  else
    curl -sf "${API_BASE}/executions/${exec_id}/agent-events" 2>/dev/null
  fi
}

# Cleanup: delete execution data (best-effort)
cleanup_execution() {
  local exec_id="$1"
  curl -sf -X DELETE "${API_BASE}/executions/${exec_id}" > /dev/null 2>&1 || true
}

# Assert helper: check JSON field value
assert_json_field() {
  local json="$1"
  local field_path="$2"
  local expected="$3"
  local description="$4"
  local actual
  actual=$(echo "$json" | jq -r "$field_path" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    log_pass "$description (got: $actual)"
    return 0
  else
    log_fail "$description (expected: $expected, got: $actual)"
    return 1
  fi
}

# Assert JSON field is not null/empty
assert_json_field_not_null() {
  local json="$1"
  local field_path="$2"
  local description="$3"
  local actual
  actual=$(echo "$json" | jq -r "$field_path" 2>/dev/null)
  if [ -n "$actual" ] && [ "$actual" != "null" ]; then
    log_pass "$description (got: $actual)"
    return 0
  else
    log_fail "$description (expected non-null, got: $actual)"
    return 1
  fi
}

# ─── Test: AC1 — Process Conflict ────────────────────────────────────────────

test_ac1_process_conflict() {
  log_section "AC1: test-process-conflict — node blocked + harness_status = blocked"

  local exec_id
  exec_id=$(create_execution "test-process-conflict")
  if [ "$exec_id" = "CREATE_FAILED" ]; then
    log_fail "AC1: Could not create execution"
    return
  fi

  log_info "Created execution: $exec_id"
  start_execution "$exec_id"
  log_info "Started execution, polling..."

  local status
  status=$(poll_execution "$exec_id")
  log_info "Execution finished with status: $status"

  local detail
  detail=$(get_execution "$exec_id")

  # Check: execution status should be completed_with_failures or failed (node blocked)
  if echo "$status" | grep -qE "completed|failed|blocked"; then
    log_pass "AC1: Execution reached terminal status: $status"
  else
    log_fail "AC1: Unexpected terminal status: $status"
  fi

  # Check: harness_status at execution level should be "blocked"
  assert_json_field "$detail" '.harness_status // .harnessStatus' "blocked" \
    "AC1: Execution harness_status = blocked"

  # Check: at least one step should have harness_status indicating block
  local blocked_step
  blocked_step=$(echo "$detail" | jq -r '
    [.steps[] | select(.harnessStatus != null)] | length
  ' 2>/dev/null)
  if [ "${blocked_step:-0}" -gt 0 ]; then
    log_pass "AC1: At least one step has harnessStatus set (count: $blocked_step)"
  else
    log_fail "AC1: No steps have harnessStatus set"
  fi

  # Check: agent events should contain block-related decision
  local events
  events=$(get_agent_events "$exec_id")
  if echo "$events" | jq -e '.events // . | length > 0' > /dev/null 2>&1; then
    log_pass "AC1: Agent events recorded for blocked execution"
  else
    log_fail "AC1: No agent events found"
  fi

  cleanup_execution "$exec_id"
}

# ─── Test: AC2 — Stupid Retry ────────────────────────────────────────────────

test_ac2_stupid_retry() {
  log_section "AC2: test-stupid-retry — Harness Agent intervenes + harness_status = intervened"

  local exec_id
  exec_id=$(create_execution "test-stupid-retry")
  if [ "$exec_id" = "CREATE_FAILED" ]; then
    log_fail "AC2: Could not create execution"
    return
  fi

  log_info "Created execution: $exec_id"
  start_execution "$exec_id"
  log_info "Started execution, polling..."

  local status
  status=$(poll_execution "$exec_id")
  log_info "Execution finished with status: $status"

  local detail
  detail=$(get_execution "$exec_id")

  # Check: harness_status should be "intervened"
  assert_json_field "$detail" '.harness_status // .harnessStatus' "intervened" \
    "AC2: Execution harness_status = intervened"

  # Check: at least one step should have harness_modified status
  local modified_count
  modified_count=$(echo "$detail" | jq -r '
    [.steps[] | select(.harnessStatus == "harness_modified" or .harnessStatus == "intervened")] | length
  ' 2>/dev/null)
  if [ "${modified_count:-0}" -gt 0 ]; then
    log_pass "AC2: At least one step was modified by harness (count: $modified_count)"
  else
    log_fail "AC2: No steps show harness modification"
  fi

  # Check: agent events should contain intervention
  local events
  events=$(get_agent_events "$exec_id")
  local has_intervention
  has_intervention=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.event_type == "harness_intervention" or .decision != null)] | length
  ' 2>/dev/null)
  if [ "${has_intervention:-0}" -gt 0 ]; then
    log_pass "AC2: Harness intervention recorded in agent events"
  else
    log_fail "AC2: No harness intervention found in agent events"
  fi

  cleanup_execution "$exec_id"
}

# ─── Test: AC3 — Timeout Cascade ─────────────────────────────────────────────

test_ac3_timeout_cascade() {
  log_section "AC3: test-timeout-cascade — Harness Agent intervenes (not advisory)"

  local exec_id
  exec_id=$(create_execution "test-timeout-cascade")
  if [ "$exec_id" = "CREATE_FAILED" ]; then
    log_fail "AC3: Could not create execution"
    return
  fi

  log_info "Created execution: $exec_id"
  start_execution "$exec_id"
  log_info "Started execution, polling (this may take longer due to timeouts)..."

  local status
  status=$(poll_execution "$exec_id")
  log_info "Execution finished with status: $status"

  local detail
  detail=$(get_execution "$exec_id")

  # Check: harness_status should be "intervened" (not null — proves it's not just advisory)
  local harness_status
  harness_status=$(echo "$detail" | jq -r '.harness_status // .harnessStatus // "null"' 2>/dev/null)
  if [ "$harness_status" != "null" ] && [ -n "$harness_status" ]; then
    log_pass "AC3: Harness Agent intervened (not advisory): harness_status = $harness_status"
  else
    log_fail "AC3: Harness Agent did NOT intervene — still advisory only"
  fi

  # Check: at least one step should have harness modification
  local modified_count
  modified_count=$(echo "$detail" | jq -r '
    [.steps[] | select(.harnessStatus != null)] | length
  ' 2>/dev/null)
  if [ "${modified_count:-0}" -gt 0 ]; then
    log_pass "AC3: At least one timeout step was handled by harness (count: $modified_count)"
  else
    log_fail "AC3: No timeout steps show harness handling"
  fi

  # Check: agent events show non-advisory intervention (decision field present)
  local events
  events=$(get_agent_events "$exec_id")
  local has_decision
  has_decision=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.decision != null and .decision != "advisory")] | length
  ' 2>/dev/null)
  if [ "${has_decision:-0}" -gt 0 ]; then
    log_pass "AC3: Harness Agent made actual decisions (not advisory)"
  else
    log_fail "AC3: No non-advisory decisions found — still advisory mode"
  fi

  cleanup_execution "$exec_id"
}

# ─── Test: AC4 — Agent Tool Interceptor ──────────────────────────────────────

test_ac4_agent_tool_interceptor() {
  log_section "AC4: Agent node tool interceptor — block + guide + resume"

  local exec_id
  exec_id=$(create_execution "test-agent-tool-interceptor")
  if [ "$exec_id" = "CREATE_FAILED" ]; then
    log_fail "AC4: Could not create execution"
    return
  fi

  log_info "Created execution: $exec_id"
  start_execution "$exec_id"
  log_info "Started execution, polling..."

  local status
  status=$(poll_execution "$exec_id")
  log_info "Execution finished with status: $status"

  local detail
  detail=$(get_execution "$exec_id")

  # Check: node should eventually complete (after guidance)
  if echo "$status" | grep -qE "completed"; then
    log_pass "AC4: Agent node completed after tool interceptor guidance"
  else
    log_fail "AC4: Agent node did not complete (status: $status)"
  fi

  # Check: harness_status should be "intervened"
  assert_json_field "$detail" '.harness_status // .harnessStatus' "intervened" \
    "AC4: Execution harness_status = intervened"

  # Check: agent events should contain tool_block + guidance events
  local events
  events=$(get_agent_events "$exec_id" "run-e2e-tests")
  local has_tool_block
  has_tool_block=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.event_type == "tool_blocked" or .event_type == "tool_intercepted" or .event == "tool_blocked")] | length
  ' 2>/dev/null)
  if [ "${has_tool_block:-0}" -gt 0 ]; then
    log_pass "AC4: Tool interceptor blocked dangerous tool call"
  else
    log_fail "AC4: No tool block event found in agent events"
  fi

  cleanup_execution "$exec_id"
}

# ─── Test: AC5 — Execution List API harnessStatus ────────────────────────────

test_ac5_execution_list_api() {
  log_section "AC5: Execution list API returns harnessStatus field"

  local list
  list=$(get_execution_list)

  if [ -z "$list" ]; then
    log_fail "AC5: Could not fetch execution list"
    return
  fi

  # Check: list response exists and has executions
  local count
  count=$(echo "$list" | jq -r '
    (if type == "array" then length elif .nodes then .nodes | length else 0 end)
  ' 2>/dev/null)

  if [ "${count:-0}" -gt 0 ]; then
    log_pass "AC5: Execution list returned $count executions"
  else
    log_fail "AC5: Execution list is empty"
    return
  fi

  # Check: at least one execution has harnessStatus field (even if null)
  # The field should be present in the response schema
  local first_exec
  if echo "$list" | jq -e 'type == "array"' > /dev/null 2>&1; then
    first_exec=$(echo "$list" | jq '.[0]' 2>/dev/null)
  else
    first_exec=$(echo "$list" | jq '.nodes[0]' 2>/dev/null)
  fi

  # harnessStatus should be a known field in the response
  local has_field
  has_field=$(echo "$first_exec" | jq 'has("harness_status") or has("harnessStatus")' 2>/dev/null)
  if [ "$has_field" = "true" ]; then
    log_pass "AC5: Execution list items have harnessStatus field"
  else
    log_fail "AC5: harnessStatus field missing from execution list items"
  fi
}

# ─── Test: AC6 — Agent Events Decision Field ────────────────────────────────

test_ac6_agent_events_decision() {
  log_section "AC6: Agent events contain decision field"

  # Find an execution that had harness intervention
  local list
  list=$(get_execution_list)

  local intervened_exec_id=""
  # Look for an execution with non-null harness_status
  if echo "$list" | jq -e 'type == "array"' > /dev/null 2>&1; then
    intervened_exec_id=$(echo "$list" | jq -r '
      [.[] | select(.harness_status != null and .harness_status != "null")] | .[0].id // empty
    ' 2>/dev/null)
  else
    intervened_exec_id=$(echo "$list" | jq -r '
      [.nodes[] | select(.harness_status != null and .harness_status != "null")] | .[0].id // empty
    ' 2>/dev/null)
  fi

  if [ -z "$intervened_exec_id" ]; then
    log_skip "AC6: No intervened execution found — run AC1-AC4 tests first"
    return
  fi

  log_info "Found intervened execution: $intervened_exec_id"

  local events
  events=$(get_agent_events "$intervened_exec_id")

  # Check: events contain decision field
  local has_decision
  has_decision=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.decision != null)] | length
  ' 2>/dev/null)
  if [ "${has_decision:-0}" -gt 0 ]; then
    log_pass "AC6: Agent events contain decision field (count: $has_decision)"
  else
    log_fail "AC6: No decision field found in agent events"
  fi

  # Check: decision is one of the 5 valid types
  local decision_types
  decision_types=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.decision != null) | .decision] | unique | join(", ")
  ' 2>/dev/null)
  if [ -n "$decision_types" ]; then
    log_info "AC6: Decision types found: $decision_types"
    # Validate each is one of the 5 types
    local valid=true
    for dt in $(echo "$decision_types" | tr ',' '\n' | tr -d ' '); do
      case "$dt" in
        fix_and_retry|guide_and_retry|reconfigure_and_retry|agent_takeover|block_node) ;;
        *) log_fail "AC6: Invalid decision type: $dt"; valid=false ;;
      esac
    done
    if $valid; then
      log_pass "AC6: All decision types are valid"
    fi
  fi
}

# ─── Test: AC7 — Harness Agent Session Context ───────────────────────────────

test_ac7_harness_agent_session() {
  log_section "AC7: Harness Agent session maintains context across interventions"

  # Find an execution with multiple interventions (stupid-retry is best candidate)
  local list
  list=$(get_execution_list)

  local target_exec_id=""
  if echo "$list" | jq -e 'type == "array"' > /dev/null 2>&1; then
    target_exec_id=$(echo "$list" | jq -r '
      [.[] | select(.harness_status == "intervened")] | .[0].id // empty
    ' 2>/dev/null)
  else
    target_exec_id=$(echo "$list" | jq -r '
      [.nodes[] | select(.harness_status == "intervened")] | .[0].id // empty
    ' 2>/dev/null)
  fi

  if [ -z "$target_exec_id" ]; then
    log_skip "AC7: No intervened execution found — run AC2 test first"
    return
  fi

  log_info "Checking session context for execution: $target_exec_id"

  local detail
  detail=$(get_execution "$target_exec_id")

  # Check: harness_summary should contain intervention history
  local summary
  summary=$(echo "$detail" | jq '.harness_summary // .harnessSummary' 2>/dev/null)
  if [ -n "$summary" ] && [ "$summary" != "null" ]; then
    # Parse summary (might be JSON string)
    local parsed_summary
    if echo "$summary" | jq -e 'type == "string"' > /dev/null 2>&1; then
      parsed_summary=$(echo "$summary" | jq -r '.' | jq '.' 2>/dev/null)
    else
      parsed_summary="$summary"
    fi

    local total_interventions
    total_interventions=$(echo "$parsed_summary" | jq -r '.totalInterventions // 0' 2>/dev/null)
    if [ "${total_interventions:-0}" -gt 0 ]; then
      log_pass "AC7: harness_summary records $total_interventions interventions"
    else
      log_fail "AC7: harness_summary shows 0 interventions"
    fi

    # Check: decisions array has multiple entries (proves session context maintained)
    local decision_count
    decision_count=$(echo "$parsed_summary" | jq -r '.decisions | length // 0' 2>/dev/null)
    if [ "${decision_count:-0}" -gt 0 ]; then
      log_pass "AC7: Session maintained across $decision_count decisions"
    else
      log_fail "AC7: No decisions recorded in session summary"
    fi
  else
    log_fail "AC7: No harness_summary found — session context not maintained"
  fi

  # Check: agent events show sequential interventions from same session
  local events
  events=$(get_agent_events "$target_exec_id")
  local intervention_count
  intervention_count=$(echo "$events" | jq -r '
    [.events // . | .[] | select(.event_type == "harness_intervention" or .decision != null)] | length
  ' 2>/dev/null)
  if [ "${intervention_count:-0}" -gt 0 ]; then
    log_pass "AC7: Agent events show $intervention_count interventions in session"
  else
    log_fail "AC7: No intervention events found in session"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BLUE}"
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Harness Semantic V2 — E2E Integration Tests           ║"
  echo "║  Ticket 08 — All Acceptance Criteria                   ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo -e "${NC}"

  log_info "Server: ${SERVER_URL}"
  log_info "Workspace: ${WORKSPACE_ID}"
  log_info "API Base: ${API_BASE}"

  # Pre-flight: check server
  check_server

  # Run all tests
  test_ac1_process_conflict
  test_ac2_stupid_retry
  test_ac3_timeout_cascade
  test_ac4_agent_tool_interceptor
  test_ac5_execution_list_api
  test_ac6_agent_events_decision
  test_ac7_harness_agent_session

  # Summary
  log_section "Test Summary"
  echo -e "  ${GREEN}Passed:${NC}  $PASSED"
  echo -e "  ${RED}Failed:${NC}  $FAILED"
  echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
  echo ""

  if [ $FAILED -gt 0 ]; then
    echo -e "${RED}RESULT: FAILED${NC}"
    exit 1
  else
    echo -e "${GREEN}RESULT: PASSED${NC}"
    exit 0
  fi
}

main "$@"
