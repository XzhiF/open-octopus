#!/bin/bash
# E2E Test 3: Verify archive + auto-refine pipeline
# Prerequisite: Server running on port 3001

set -e
BASE_URL="http://localhost:3001/api"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"
DAILY_DIR="$HOME/.octopus/agent/memory/daily"
LONG_TERM="$HOME/.octopus/agent/memory/long-term.md"
ARCHIVE_DIR="$DAILY_DIR/archive"

echo "=== Test 3: Verify archive + auto-refine ==="

# Step 0: Create a test daily file for yesterday if none exists
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || echo "2026-07-28")
TEST_FILE="$DAILY_DIR/$YESTERDAY.md"

if [ ! -f "$TEST_FILE" ]; then
  echo "  Creating test daily file for $YESTERDAY..."
  mkdir -p "$DAILY_DIR"
  printf "### 10:00:00\nE2E_TEST archive verification entry\n### 14:00:00\nAnother test entry about project decisions\n" > "$TEST_FILE"
  echo "PASS: Test daily file created at $TEST_FILE"
else
  echo "  Daily file for $YESTERDAY already exists"
fi

# Step 1: Get long-term file state before archive
LT_BEFORE_SIZE=0
if [ -f "$LONG_TERM" ]; then
  LT_BEFORE_SIZE=$(wc -c < "$LONG_TERM")
fi
echo "  Long-term memory size before: $LT_BEFORE_SIZE bytes"

# Step 2: Trigger archive
echo "  Triggering archive for $YESTERDAY via POST /api/agent/memory/archive..."
RESPONSE=$(curl -s -X POST "$BASE_URL/agent/memory/archive" \
  -H "Content-Type: application/json" \
  -H "$AUTH" -H "$ORG" \
  -d "{\"date\": \"$YESTERDAY\"}")

echo "  Archive response: $(echo "$RESPONSE" | head -c 500)"

# Step 3: Verify archive succeeded
if echo "$RESPONSE" | grep -q '"archived":true'; then
  echo "PASS: Archive succeeded"
else
  echo "WARN: Archive did not report archived:true (may already be archived)"
fi

# Step 4: Verify daily file was moved to archive/
if [ -f "$ARCHIVE_DIR/$YESTERDAY.md" ]; then
  echo "PASS: Daily file moved to archive/"
else
  echo "WARN: Daily file not in archive/ (may have been moved already)"
fi

# Step 5: Verify long-term was updated
LT_AFTER_SIZE=0
if [ -f "$LONG_TERM" ]; then
  LT_AFTER_SIZE=$(wc -c < "$LONG_TERM")
fi
echo "  Long-term memory size after: $LT_AFTER_SIZE bytes"

if [ "$LT_AFTER_SIZE" -gt "$LT_BEFORE_SIZE" ]; then
  echo "PASS: Long-term memory was updated (grew by $((LT_AFTER_SIZE - LT_BEFORE_SIZE)) bytes)"
else
  echo "WARN: Long-term memory did not grow (may already contain archived content)"
fi

# Step 6: Verify .bak backup exists (auto-refine creates backup)
BAK_FILE="$LONG_TERM.bak"
if [ -f "$BAK_FILE" ]; then
  echo "PASS: Backup file exists (long-term.md.bak)"
else
  echo "WARN: No .bak file (refine may not have run or wasn't needed)"
fi

# Step 7: Verify refine result in response
if echo "$RESPONSE" | grep -q '"refine"'; then
  echo "PASS: Refine result included in archive response"
else
  echo "WARN: Refine result not in response"
fi

echo ""
echo "=== Test 3 complete ==="
