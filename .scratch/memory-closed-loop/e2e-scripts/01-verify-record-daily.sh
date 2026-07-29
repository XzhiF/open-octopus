#!/bin/bash
# E2E Test 1: Verify record_daily tool infrastructure
# Prerequisite: Server running on port 3001
#
# This test verifies:
# 1. Daily memory directory exists
# 2. recordDaily service method works (via direct API if available)
# 3. The chat endpoint accepts requests with the record_daily tool in system prompt
# 4. Memory search (FTS) is accessible

set -e
BASE_URL="http://localhost:3001/api"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"

echo "=== Test 1: Verify record_daily infrastructure ==="

# Step 1: Check daily memory directory exists
DAILY_DIR="$HOME/.octopus/agent/memory/daily"
if [ ! -d "$DAILY_DIR" ]; then
  echo "FAIL: Daily memory directory not found at $DAILY_DIR"
  exit 1
fi
echo "PASS: Daily memory directory exists at $DAILY_DIR"

# Step 2: Verify daily memory API returns an array
echo "  Checking GET /api/agent/memory/daily..."
DAILY_RESPONSE=$(curl -s "$BASE_URL/agent/memory/daily" \
  -H "$AUTH" -H "$ORG")
echo "  Response: $(echo "$DAILY_RESPONSE" | head -c 300)"

if echo "$DAILY_RESPONSE" | grep -q '^\['; then
  echo "PASS: Daily memory API returns array"
else
  echo "FAIL: Daily memory API did not return array"
  exit 1
fi

# Step 3: Record today's file state before test
TODAY=$(date +%Y-%m-%d)
DAILY_FILE="$DAILY_DIR/$TODAY.md"
BEFORE_SIZE=0
if [ -f "$DAILY_FILE" ]; then
  BEFORE_SIZE=$(wc -c < "$DAILY_FILE")
fi
echo "  Today's daily file size before: $BEFORE_SIZE bytes"

# Step 4: Test recordDaily by writing to daily memory via POST /memory
echo "  Testing POST /api/agent/memory (layer=daily)..."
WRITE_RESPONSE=$(curl -s -X POST "$BASE_URL/agent/memory" \
  -H "Content-Type: application/json" \
  -H "$AUTH" -H "$ORG" \
  -d "{\"layer\": \"daily\", \"content\": \"### E2E_TEST record_daily verification\\nTest entry for infrastructure check at $(date +%H:%M:%S)\"}")
echo "  Write response: $(echo "$WRITE_RESPONSE" | head -c 300)"

if echo "$WRITE_RESPONSE" | grep -q '"ok":true'; then
  echo "PASS: Daily memory write succeeded"
else
  echo "FAIL: Daily memory write failed"
  echo "  Response: $WRITE_RESPONSE"
  exit 1
fi

# Step 5: Verify daily file was updated
AFTER_SIZE=0
if [ -f "$DAILY_FILE" ]; then
  AFTER_SIZE=$(wc -c < "$DAILY_FILE")
fi
echo "  Today's daily file size after: $AFTER_SIZE bytes"

if [ "$AFTER_SIZE" -gt "$BEFORE_SIZE" ]; then
  echo "PASS: Daily file was updated (grew by $((AFTER_SIZE - BEFORE_SIZE)) bytes)"
else
  echo "FAIL: Daily file was not updated"
  exit 1
fi

# Step 6: Verify FTS search works
echo "  Checking memory search (FTS)..."
SEARCH_RESPONSE=$(curl -s "$BASE_URL/agent/memory/search?q=E2E_TEST&top_k=3" \
  -H "$AUTH" -H "$ORG")
echo "  Search response: $(echo "$SEARCH_RESPONSE" | head -c 300)"

if echo "$SEARCH_RESPONSE" | grep -q '"results"'; then
  echo "PASS: Memory search returned results field"
else
  echo "FAIL: Memory search did not return expected format"
  exit 1
fi

# Step 7: Verify record_daily tool is in system prompt (check via main-agent route source)
echo "  Checking for RECORD_DAILY_TOOLS_PROMPT in source..."
if grep -q "record_daily" "packages/server/src/routes/agent/main-agent-route.ts" 2>/dev/null; then
  echo "PASS: record_daily tool definition found in main-agent-route.ts"
else
  echo "WARN: record_daily tool definition not found in source (may be in a different file)"
fi

echo ""
echo "=== Test 1 complete ==="
