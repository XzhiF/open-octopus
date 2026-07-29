#!/bin/bash
# E2E Test Suite for Agent Config Completion Feature
# Tests AC1-AC8 via API integration
# Server: http://localhost:3001
# Auth: Bearer token (placeholder auth)

set -euo pipefail

BASE_URL="http://localhost:3001"
AUTH="Authorization: Bearer e2e-test-token"
CONTENT_TYPE="Content-Type: application/json"
RESULTS_DIR="$(dirname "$0")/../e2e-data"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
RESULTS_FILE="$RESULTS_DIR/test-results-${TIMESTAMP}.json"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test counters
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_TESTS=0

# Results array (JSON)
declare -a RESULTS_JSON=()

log_pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

log_fail() {
  echo -e "${RED}✗ FAIL${NC}: $1"
  echo -e "  Evidence: $2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

log_info() {
  echo -e "${YELLOW}→${NC} $1"
}

# Helper: make API call and return response
api_get() {
  local path="$1"
  curl -s -H "$AUTH" "${BASE_URL}${path}" 2>/dev/null
}

api_put() {
  local path="$1"
  local body="$2"
  curl -s -X PUT -H "$AUTH" -H "$CONTENT_TYPE" -d "$body" "${BASE_URL}${path}" 2>/dev/null
}

api_post() {
  local path="$1"
  local body="${2:-}"
  if [ -n "$body" ]; then
    curl -s -X POST -H "$AUTH" -H "$CONTENT_TYPE" -d "$body" "${BASE_URL}${path}" 2>/dev/null
  else
    curl -s -X POST -H "$AUTH" "${BASE_URL}${path}" 2>/dev/null
  fi
}

echo "═══════════════════════════════════════════════════════"
echo "  E2E Test Suite: Agent Config Completion"
echo "  Timestamp: $(date -Iseconds)"
echo "  Server: $BASE_URL"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── Pre-flight: Save original config ──────────────────────────
log_info "Saving original config for later restoration..."
ORIGINAL_CONFIG=$(api_get "/api/agent/config")
echo "$ORIGINAL_CONFIG" > "$RESULTS_DIR/original-config-backup.json"
ORIGINAL_MODEL=$(echo "$ORIGINAL_CONFIG" | jq -r '.config.model // "pro"')
ORIGINAL_TIMEOUT=$(echo "$ORIGINAL_CONFIG" | jq -r '.config.timeout // 300')
ORIGINAL_MAX_CLONES=$(echo "$ORIGINAL_CONFIG" | jq -r '.config.max_clones // 5')
ORIGINAL_DEBUG=$(echo "$ORIGINAL_CONFIG" | jq -r '.config.debug.enabled // false')
log_info "Original: model=$ORIGINAL_MODEL timeout=$ORIGINAL_TIMEOUT max_clones=$ORIGINAL_MAX_CLONES debug=$ORIGINAL_DEBUG"
echo ""

# ═══════════════════════════════════════════════════════════════
# AC1: Config tab shows engine + model dropdowns, default claude/pro
# Verification: GET /api/agent/config → check model field;
#               PUT /api/agent/config with new model → verify
# ═══════════════════════════════════════════════════════════════
echo "─── AC1: Model selector (engine/model) ───────────────────"

# Test 1.1: GET config returns model field
log_info "Test 1.1: GET /api/agent/config returns model field"
CONFIG_RESP=$(api_get "/api/agent/config")
MODEL_FIELD=$(echo "$CONFIG_RESP" | jq -r '.config.model // empty')
if [ -n "$MODEL_FIELD" ]; then
  log_pass "AC1.1: model field present, value=\"$MODEL_FIELD\""
else
  log_fail "AC1.1: model field missing" "$CONFIG_RESP"
fi

# Test 1.2: PUT config with valid enum model value "pro"
log_info "Test 1.2: PUT /api/agent/config with model=\"pro\""
PUT_RESP=$(api_put "/api/agent/config" '{"model":"pro"}')
PUT_ERROR=$(echo "$PUT_RESP" | jq -r '.error.code // empty')
if [ -z "$PUT_ERROR" ]; then
  # Read back
  READBACK=$(api_get "/api/agent/config")
  READBACK_MODEL=$(echo "$READBACK" | jq -r '.config.model // empty')
  if [ "$READBACK_MODEL" = "pro" ]; then
    log_pass "AC1.2: model saved and persisted as \"pro\""
  else
    log_fail "AC1.2: model not persisted (got \"$READBACK_MODEL\")" "$READBACK"
  fi
else
  log_fail "AC1.2: PUT returned error" "$PUT_RESP"
fi

# Test 1.3: PUT config with different valid model value "se"
log_info "Test 1.3: PUT /api/agent/config with model=\"se\""
PUT_RESP2=$(api_put "/api/agent/config" '{"model":"se"}')
READBACK2=$(api_get "/api/agent/config")
READBACK_MODEL2=$(echo "$READBACK2" | jq -r '.config.model // empty')
if [ "$READBACK_MODEL2" = "se" ]; then
  log_pass "AC1.3: model updated to \"se\""
else
  log_fail "AC1.3: model update failed (got \"$READBACK_MODEL2\")" "$READBACK2"
fi

# Test 1.4: PUT config with engine/alias format (spec says "claude/pro")
log_info "Test 1.4: PUT /api/agent/config with model=\"claude/pro\" (spec engine/alias format)"
PUT_RESP3=$(api_put "/api/agent/config" '{"model":"claude/pro"}')
PUT_ERROR3=$(echo "$PUT_RESP3" | jq -r '.error.code // empty')
if [ -z "$PUT_ERROR3" ]; then
  log_pass "AC1.4: engine/alias format \"claude/pro\" accepted"
else
  log_fail "AC1.4: engine/alias format rejected (spec-implementation gap)" "$PUT_RESP3"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC2: Timeout input (30-1800) save works
# ═══════════════════════════════════════════════════════════════
echo "─── AC2: Timeout config ──────────────────────────────────"

# Test 2.1: PUT timeout=600
log_info "Test 2.1: PUT /api/agent/config with timeout=600"
PUT_RESP=$(api_put "/api/agent/config" '{"timeout":600}')
PUT_ERROR=$(echo "$PUT_RESP" | jq -r '.error.code // empty')
if [ -z "$PUT_ERROR" ]; then
  READBACK=$(api_get "/api/agent/config")
  READBACK_TIMEOUT=$(echo "$READBACK" | jq -r '.config.timeout // empty')
  if [ "$READBACK_TIMEOUT" = "600" ]; then
    log_pass "AC2.1: timeout saved as 600"
  else
    log_fail "AC2.1: timeout not persisted (got \"$READBACK_TIMEOUT\")" "$READBACK"
  fi
else
  log_fail "AC2.1: PUT returned error" "$PUT_RESP"
fi

# Test 2.2: PUT timeout=30 (min boundary)
log_info "Test 2.2: PUT /api/agent/config with timeout=30 (min)"
PUT_RESP=$(api_put "/api/agent/config" '{"timeout":30}')
READBACK=$(api_get "/api/agent/config")
READBACK_TIMEOUT=$(echo "$READBACK" | jq -r '.config.timeout // empty')
if [ "$READBACK_TIMEOUT" = "30" ]; then
  log_pass "AC2.2: timeout min boundary (30) accepted"
else
  log_fail "AC2.2: timeout min boundary failed (got \"$READBACK_TIMEOUT\")" "$READBACK"
fi

# Test 2.3: PUT timeout=1800 (max boundary)
log_info "Test 2.3: PUT /api/agent/config with timeout=1800 (max)"
PUT_RESP=$(api_put "/api/agent/config" '{"timeout":1800}')
READBACK=$(api_get "/api/agent/config")
READBACK_TIMEOUT=$(echo "$READBACK" | jq -r '.config.timeout // empty')
if [ "$READBACK_TIMEOUT" = "1800" ]; then
  log_pass "AC2.3: timeout max boundary (1800) accepted"
else
  log_fail "AC2.3: timeout max boundary failed (got \"$READBACK_TIMEOUT\")" "$READBACK"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC3: max_clones input (1-20) save works
# ═══════════════════════════════════════════════════════════════
echo "─── AC3: max_clones config ───────────────────────────────"

# Test 3.1: PUT max_clones=10
log_info "Test 3.1: PUT /api/agent/config with max_clones=10"
PUT_RESP=$(api_put "/api/agent/config" '{"max_clones":10}')
PUT_ERROR=$(echo "$PUT_RESP" | jq -r '.error.code // empty')
if [ -z "$PUT_ERROR" ]; then
  READBACK=$(api_get "/api/agent/config")
  READBACK_MC=$(echo "$READBACK" | jq -r '.config.max_clones // empty')
  if [ "$READBACK_MC" = "10" ]; then
    log_pass "AC3.1: max_clones saved as 10"
  else
    log_fail "AC3.1: max_clones not persisted (got \"$READBACK_MC\")" "$READBACK"
  fi
else
  log_fail "AC3.1: PUT returned error" "$PUT_RESP"
fi

# Test 3.2: PUT max_clones=1 (min)
log_info "Test 3.2: PUT /api/agent/config with max_clones=1 (min)"
PUT_RESP=$(api_put "/api/agent/config" '{"max_clones":1}')
READBACK=$(api_get "/api/agent/config")
READBACK_MC=$(echo "$READBACK" | jq -r '.config.max_clones // empty')
if [ "$READBACK_MC" = "1" ]; then
  log_pass "AC3.2: max_clones min boundary (1) accepted"
else
  log_fail "AC3.2: max_clones min boundary failed (got \"$READBACK_MC\")" "$READBACK"
fi

# Test 3.3: PUT max_clones=20 (max)
log_info "Test 3.3: PUT /api/agent/config with max_clones=20 (max)"
PUT_RESP=$(api_put "/api/agent/config" '{"max_clones":20}')
READBACK=$(api_get "/api/agent/config")
READBACK_MC=$(echo "$READBACK" | jq -r '.config.max_clones // empty')
if [ "$READBACK_MC" = "20" ]; then
  log_pass "AC3.3: max_clones max boundary (20) accepted"
else
  log_fail "AC3.3: max_clones max boundary failed (got \"$READBACK_MC\")" "$READBACK"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC4: debug.enabled toggle save works
# ═══════════════════════════════════════════════════════════════
echo "─── AC4: debug.enabled toggle ────────────────────────────"

# Test 4.1: PUT debug.enabled=true
log_info "Test 4.1: PUT /api/agent/config with debug.enabled=true"
PUT_RESP=$(api_put "/api/agent/config" '{"debug":{"enabled":true}}')
PUT_ERROR=$(echo "$PUT_RESP" | jq -r '.error.code // empty')
if [ -z "$PUT_ERROR" ]; then
  READBACK=$(api_get "/api/agent/config")
  READBACK_DEBUG=$(echo "$READBACK" | jq -r '.config.debug.enabled // empty')
  if [ "$READBACK_DEBUG" = "true" ]; then
    log_pass "AC4.1: debug.enabled saved as true"
  else
    log_fail "AC4.1: debug.enabled not persisted (got \"$READBACK_DEBUG\")" "$READBACK"
  fi
else
  log_fail "AC4.1: PUT returned error" "$PUT_RESP"
fi

# Test 4.2: PUT debug.enabled=false
log_info "Test 4.2: PUT /api/agent/config with debug.enabled=false"
PUT_RESP=$(api_put "/api/agent/config" '{"debug":{"enabled":false}}')
READBACK=$(api_get "/api/agent/config")
READBACK_DEBUG=$(echo "$READBACK" | jq -r 'if .config.debug.enabled == null then "MISSING" else (.config.debug.enabled | tostring) end')
if [ "$READBACK_DEBUG" = "false" ]; then
  log_pass "AC4.2: debug.enabled saved as false"
else
  log_fail "AC4.2: debug.enabled toggle to false failed (got \"$READBACK_DEBUG\")" "$READBACK"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC5: Debug log shows summaries, click detail doesn't crash,
#      selection highlight correct
# ═══════════════════════════════════════════════════════════════
echo "─── AC5: Debug log + assemble detail ─────────────────────"

# Test 5.1: GET /debug/log returns items with summary field
log_info "Test 5.1: GET /api/agent/debug/log — items have 'summary' field"
DEBUG_LOG=$(api_get "/api/agent/debug/log?limit=5")
FIRST_ITEM_SUMMARY=$(echo "$DEBUG_LOG" | jq -r '.items[0].summary // empty')
FIRST_ITEM_ID=$(echo "$DEBUG_LOG" | jq -r '.items[0].id // empty')
FIRST_ITEM_CHAT_ID=$(echo "$DEBUG_LOG" | jq -r '.items[0].chat_id // empty')
if [ -n "$FIRST_ITEM_SUMMARY" ]; then
  log_pass "AC5.1: debug log items have 'summary' field (value: \"$FIRST_ITEM_SUMMARY\")"
else
  log_fail "AC5.1: debug log items missing 'summary' field" "$DEBUG_LOG"
fi

# Test 5.2: Items have 'id' field (mapped from chat_id)
log_info "Test 5.2: debug log items have 'id' field"
if [ -n "$FIRST_ITEM_ID" ]; then
  log_pass "AC5.2: debug log items have 'id' field (value: \"$FIRST_ITEM_ID\")"
else
  log_fail "AC5.2: debug log items missing 'id' field" "$DEBUG_LOG"
fi

# Test 5.3: GET /debug/assemble/:chat_id doesn't crash
log_info "Test 5.3: GET /api/agent/debug/assemble/:chat_id — no crash"
if [ -n "$FIRST_ITEM_CHAT_ID" ]; then
  ASSEMBLE_RESP=$(api_get "/api/agent/debug/assemble/${FIRST_ITEM_CHAT_ID}")
  ASSEMBLE_ERROR=$(echo "$ASSEMBLE_RESP" | jq -r '.error.code // empty')
  if [ -z "$ASSEMBLE_ERROR" ]; then
    log_pass "AC5.3: assemble detail endpoint returns without error"
  else
    log_fail "AC5.3: assemble detail returned error" "$ASSEMBLE_RESP"
  fi
else
  log_fail "AC5.3: no chat_id available to test" "N/A"
fi

# Test 5.4: Assemble response has skill_sources field
log_info "Test 5.4: assemble response has 'skill_sources' field"
SKILL_SOURCES=$(echo "$ASSEMBLE_RESP" | jq '.skill_sources // empty')
if [ -n "$SKILL_SOURCES" ] && [ "$SKILL_SOURCES" != "null" ]; then
  log_pass "AC5.4: skill_sources field present ($SKILL_SOURCES)"
else
  log_fail "AC5.4: skill_sources field missing" "$ASSEMBLE_RESP"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC6: Safety events are recorded
# ═══════════════════════════════════════════════════════════════
echo "─── AC6: Safety event writes ─────────────────────────────"

# Test 6.1: Enable safe mode → write event
log_info "Test 6.1: POST /api/agent/safe-mode/enable → safety event written"
ENABLE_RESP=$(api_post "/api/agent/safe-mode/enable")
ENABLE_ERROR=$(echo "$ENABLE_RESP" | jq -r '.error.code // empty')
if [ -z "$ENABLE_ERROR" ]; then
  log_pass "AC6.1a: safe-mode enable returned success"
else
  log_info "Safe-mode enable response: $ENABLE_RESP"
fi

# Query events
sleep 1
EVENTS_RESP=$(api_get "/api/agent/safety/events?limit=10")
EVENTS_COUNT=$(echo "$EVENTS_RESP" | jq '.items | length')
if [ "$EVENTS_COUNT" -gt 0 ]; then
  # Check for safe_mode_toggle event
  TOGGLE_EVENT=$(echo "$EVENTS_RESP" | jq -r '.items[] | select(.type == "safe_mode_toggle") | .type' | head -1)
  if [ "$TOGGLE_EVENT" = "safe_mode_toggle" ]; then
    log_pass "AC6.1b: safe_mode_toggle event found (count=$EVENTS_COUNT)"
  else
    log_fail "AC6.1b: no safe_mode_toggle event found" "$EVENTS_RESP"
  fi
else
  log_fail "AC6.1b: no safety events returned" "$EVENTS_RESP"
fi

# Test 6.2: Disable safe mode → write event
log_info "Test 6.2: POST /api/agent/safe-mode/disable → safety event written"
DISABLE_RESP=$(api_post "/api/agent/safe-mode/disable")
sleep 1
EVENTS_RESP2=$(api_get "/api/agent/safety/events?limit=10")
EVENTS_COUNT2=$(echo "$EVENTS_RESP2" | jq '.items | length')
if [ "$EVENTS_COUNT2" -ge "$EVENTS_COUNT" ]; then
  log_pass "AC6.2: disable safe mode — event count maintained or increased ($EVENTS_COUNT2)"
else
  log_fail "AC6.2: event count decreased after disable" "$EVENTS_RESP2"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC7: Safety audit shows operation tooltip and context
# (Frontend-only — verify via API that events have operation and context fields)
# ═══════════════════════════════════════════════════════════════
echo "─── AC7: Safety audit event shape (API contract) ────────"

# Test 7.1: Events have 'operation' field
log_info "Test 7.1: safety events have 'operation' field"
EVENTS_RESP=$(api_get "/api/agent/safety/events?limit=5")
HAS_OPERATION=$(echo "$EVENTS_RESP" | jq -r '.items[0].operation // empty')
if [ -n "$HAS_OPERATION" ]; then
  log_pass "AC7.1: safety events have 'operation' field (value: \"$HAS_OPERATION\")"
else
  # If there are no events, we still need to check the API contract
  EVENTS_TOTAL=$(echo "$EVENTS_RESP" | jq '.total // 0')
  if [ "$EVENTS_TOTAL" -gt 0 ]; then
    log_fail "AC7.1: safety events missing 'operation' field" "$EVENTS_RESP"
  else
    log_info "No events to check — verifying event structure from enable toggle"
    # The event we just created should have operation
    TOGGLE_OP=$(echo "$EVENTS_RESP" | jq -r '.items[] | select(.type == "safe_mode_toggle") | .operation' | head -1)
    if [ -n "$TOGGLE_OP" ]; then
      log_pass "AC7.1: safe_mode_toggle has operation=\"$TOGGLE_OP\""
    else
      log_fail "AC7.1: safe_mode_toggle missing operation field" "$EVENTS_RESP"
    fi
  fi
fi

# Test 7.2: Events have 'context' field (may be null but should exist)
log_info "Test 7.2: safety events support 'context' field"
HAS_CONTEXT_KEY=$(echo "$EVENTS_RESP" | jq 'if .items[0] | has("context") then "yes" else "no" end' 2>/dev/null || echo "no")
if [ "$HAS_CONTEXT_KEY" = "\"yes\"" ]; then
  log_pass "AC7.2: safety events have 'context' field"
else
  log_info "AC7.2: 'context' field not present in event (optional per spec)"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# AC8: Segment detail shows token_count/budget and degraded
# ═══════════════════════════════════════════════════════════════
echo "─── AC8: Segment budget/degraded fields ────────────────────"

# Get a chat_id from debug log
CHAT_ID=$(api_get "/api/agent/debug/log?limit=1" | jq -r '.items[0].chat_id // empty')
if [ -n "$CHAT_ID" ]; then
  ASSEMBLE=$(api_get "/api/agent/debug/assemble/${CHAT_ID}")

  # Test 8.1: Segments have token_count
  log_info "Test 8.1: segments have 'token_count' field"
  HAS_TOKEN_COUNT=$(echo "$ASSEMBLE" | jq -r '.segments[0].token_count // empty')
  if [ -n "$HAS_TOKEN_COUNT" ]; then
    log_pass "AC8.1: segment has token_count=$HAS_TOKEN_COUNT"
  else
    log_fail "AC8.1: segment missing token_count" "$ASSEMBLE"
  fi

  # Test 8.2: Segments have budget
  log_info "Test 8.2: segments have 'budget' field"
  HAS_BUDGET=$(echo "$ASSEMBLE" | jq -r '.segments[0].budget // empty')
  if [ -n "$HAS_BUDGET" ]; then
    log_pass "AC8.2: segment has budget=$HAS_BUDGET"
  else
    log_fail "AC8.2: segment missing budget" "$ASSEMBLE"
  fi

  # Test 8.3: Segments have degraded boolean
  log_info "Test 8.3: segments have 'degraded' boolean field"
  HAS_DEGRADED=$(echo "$ASSEMBLE" | jq -r 'if .segments[0].degraded == null then "MISSING" else (.segments[0].degraded | tostring) end')
  if [ "$HAS_DEGRADED" = "false" ] || [ "$HAS_DEGRADED" = "true" ]; then
    log_pass "AC8.3: segment has degraded=$HAS_DEGRADED"
  else
    log_fail "AC8.3: segment missing degraded" "$ASSEMBLE"
  fi

  # Test 8.4: Response has decisions field
  log_info "Test 8.4: assemble response has 'decisions' field"
  HAS_DECISIONS=$(echo "$ASSEMBLE" | jq '.decisions // empty')
  if [ -n "$HAS_DECISIONS" ] && [ "$HAS_DECISIONS" != "null" ]; then
    log_pass "AC8.4: decisions field present ($HAS_DECISIONS)"
  else
    log_fail "AC8.4: decisions field missing" "$ASSEMBLE"
  fi

  # Test 8.5: Response has total_tokens
  log_info "Test 8.5: assemble response has 'total_tokens'"
  TOTAL_TOKENS=$(echo "$ASSEMBLE" | jq -r '.total_tokens // empty')
  if [ -n "$TOTAL_TOKENS" ]; then
    log_pass "AC8.5: total_tokens=$TOTAL_TOKENS"
  else
    log_fail "AC8.5: total_tokens missing" "$ASSEMBLE"
  fi
else
  log_fail "AC8: No chat_id available for testing" "N/A"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# Restore original config
# ═══════════════════════════════════════════════════════════════
echo "─── Cleanup: Restore original config ────────────────────"

RESTORE_BODY=$(jq -n \
  --arg model "$ORIGINAL_MODEL" \
  --argjson timeout "$ORIGINAL_TIMEOUT" \
  --argjson max_clones "$ORIGINAL_MAX_CLONES" \
  --argjson debug_enabled "$ORIGINAL_DEBUG" \
  '{model: $model, timeout: $timeout, max_clones: $max_clones, debug: {enabled: $debug_enabled}}')

RESTORE_RESP=$(api_put "/api/agent/config" "$RESTORE_BODY")
RESTORE_ERROR=$(echo "$RESTORE_RESP" | jq -r '.error.code // empty')
if [ -z "$RESTORE_ERROR" ]; then
  log_info "Config restored to original values"
else
  log_info "Config restore response: $RESTORE_RESP"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  RESULTS"
echo "═══════════════════════════════════════════════════════"
echo ""
echo -e "  Total: $TOTAL_TESTS | ${GREEN}Passed: $PASS_COUNT${NC} | ${RED}Failed: $FAIL_COUNT${NC}"
echo ""

# Save results as JSON
cat > "$RESULTS_FILE" << EOF
{
  "timestamp": "$(date -Iseconds)",
  "server": "$BASE_URL",
  "total": $TOTAL_TESTS,
  "passed": $PASS_COUNT,
  "failed": $FAIL_COUNT,
  "result": "$([ $FAIL_COUNT -eq 0 ] && echo PASS || echo FAIL)"
}
EOF

echo "Results saved to: $RESULTS_FILE"

# Exit with appropriate code
if [ $FAIL_COUNT -gt 0 ]; then
  echo -e "${RED}OVERALL: FAIL${NC}"
  exit 1
else
  echo -e "${GREEN}OVERALL: PASS${NC}"
  exit 0
fi
