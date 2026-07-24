#!/usr/bin/env bash
# E2E API Verification Script for Clone Management Enhancement
# Runs against a live dev server (pnpm dev --isolated, port 3001)
# This script documents the expected API contract for manual verification.

set -euo pipefail

BASE_URL="${OCTOPUS_SERVER:-http://localhost:3001}"
AUTH_HEADER="Bearer e2e-test-token"

echo "=== Clone Management E2E API Verification ==="
echo "Target: $BASE_URL"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Helper function
check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  [PASS] $name"
  else
    echo "  [FAIL] $name (expected: $expected, got: $actual)"
  fi
}

# ── AC-10: GET /api/clones returns built-in + user with type field ──
echo "--- AC-10: Unified API ---"
RESP=$(curl -sS -H "Authorization: $AUTH_HEADER" "$BASE_URL/api/clones" 2>&1) || true
echo "$RESP" | head -c 2000
echo ""
check "has clones array" '"clones"' "$RESP"
check "has type field" '"type"' "$RESP"
check "has built-in" '"built-in"' "$RESP"
check "has display_name" '"display_name"' "$RESP"

# ── AC-03: POST /api/clones creates without skills ──
echo ""
echo "--- AC-03: Create without skills ---"
RESP=$(curl -sS -X POST \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"name":"e2e-test-clone","display_name":"E2E Test","persona":"Test persona"}' \
  "$BASE_URL/api/clones" 2>&1) || true
echo "$RESP" | head -c 1000
echo ""
check "creates clone" '"name":"e2e-test-clone"' "$RESP"
check "type is user" '"type":"user"' "$RESP"

# ── AC-05: File management API ──
echo ""
echo "--- AC-05: File Management ---"
RESP=$(curl -sS -H "Authorization: $AUTH_HEADER" "$BASE_URL/api/clones/workspace/files/persona.md" 2>&1) || true
echo "$RESP" | head -c 500
echo ""
check "reads persona.md" '"content"' "$RESP"

RESP=$(curl -sS -X PUT \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Updated\n\nTest content"}' \
  "$BASE_URL/api/clones/e2e-test-clone/files/persona.md" 2>&1) || true
echo "$RESP" | head -c 500
echo ""
check "writes persona.md" '"ok"' "$RESP"

# Path traversal rejection
RESP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: $AUTH_HEADER" \
  "$BASE_URL/api/clones/workspace/files/..%2F..%2Fetc%2Fpasswd" 2>&1) || true
check "path traversal rejected" "403" "$RESP"

# ── AC-04: Built-in clone deletion rejected ──
echo ""
echo "--- AC-04: Built-in deletion blocked ---"
RESP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "Authorization: $AUTH_HEADER" \
  "$BASE_URL/api/clones/workspace" 2>&1) || true
check "built-in delete returns 403" "403" "$RESP"

# ── AC-07: delegate_to delegation ──
echo ""
echo "--- AC-07: @@mention delegation ---"
RESP=$(curl -sS -N --max-time 5 \
  -X POST \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"message":"test delegation","delegate_to":"scheduler"}' \
  "$BASE_URL/api/agent/chat" 2>&1) || true
echo "$RESP" | head -c 500
echo ""
check "delegation_start event" "delegation_start" "$RESP"
check "source metadata" "scheduler" "$RESP"

# ── AC-08: Self-reference no-op ──
echo ""
echo "--- AC-08: Self-reference safety ---"
# Need a session with clone_name = 'scheduler' to test self-reference
# Self-reference should NOT produce delegation_start event
RESP=$(curl -sS -N --max-time 5 \
  -X POST \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","delegate_to":"scheduler","session_id":"test-self-ref-session"}' \
  "$BASE_URL/api/agent/chat" 2>&1) || true
echo "$RESP" | head -c 500

# ── Cleanup: Delete test clone ──
echo ""
echo "--- Cleanup ---"
RESP=$(curl -sS -X DELETE \
  -H "Authorization: $AUTH_HEADER" \
  "$BASE_URL/api/clones/e2e-test-clone" 2>&1) || true
echo "$RESP" | head -c 200
echo ""
echo "=== Done ==="
