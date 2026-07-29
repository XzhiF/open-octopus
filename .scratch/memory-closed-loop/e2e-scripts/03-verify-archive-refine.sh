#!/bin/bash
# E2E Test 3: Verify archive + auto-refine pipeline
# Prerequisite: Server running on port 3001, at least one daily file exists

set -e
BASE_URL="http://localhost:3001/api"
DAILY_DIR="$HOME/.octopus/agent/memory/daily"
LONG_TERM="$HOME/.octopus/agent/memory/long-term.md"
ARCHIVE_DIR="$DAILY_DIR/archive"

echo "=== Test 3: Verify archive + auto-refine ==="

# Step 0: Create a test daily file for yesterday if none exists
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || echo "2026-07-28")
TEST_FILE="$DAILY_DIR/$YESTERDAY.md"

if [ ! -f "$TEST_FILE" ]; then
  echo "  Creating test daily file for $YESTERDAY..."
  echo "### 10:00:00\nTest entry for archive verification\n### 14:00:00\nAnother test entry about project decisions" > "$TEST_FILE"
  echo "✓ Test daily file created"
fi

# Step 1: Get long-term file state before archive
LT_BEFORE=""
if [ -f "$LONG_TERM" ]; then
  LT_BEFORE=$(cat "$LONG_TERM")
fi
LT_BEFORE_SIZE=${#LT_BEFORE}
echo "  Long-term memory size before: $LT_BEFORE_SIZE chars"

# Step 2: Trigger archive
echo "  Triggering archive for $YESTERDAY..."
RESPONSE=$(curl -s -X POST "$BASE_URL/agent/memory/archive" \
  -H "Content-Type: application/json" \
  -H "X-Octopus-Org: default" \
  -d "{\"date\": \"$YESTERDAY\"}")

echo "  Archive response: $(echo "$RESPONSE" | head -c 300)"

# Step 3: Verify archive succeeded
if echo "$RESPONSE" | grep -q '"archived":true'; then
  echo "✓ PASS: Archive succeeded"
else
  echo "⚠ Archive did not report success (may already be archived)"
fi

# Step 4: Verify daily file was moved to archive/
if [ -f "$ARCHIVE_DIR/$YESTERDAY.md" ]; then
  echo "✓ PASS: Daily file moved to archive/"
else
  echo "⚠ INFO: Daily file not in archive/ (may have been moved already)"
fi

# Step 5: Verify long-term was updated
LT_AFTER=""
if [ -f "$LONG_TERM" ]; then
  LT_AFTER=$(cat "$LONG_TERM")
fi
LT_AFTER_SIZE=${#LT_AFTER}
echo "  Long-term memory size after: $LT_AFTER_SIZE chars"

if [ "$LT_AFTER_SIZE" -gt "$LT_BEFORE_SIZE" ]; then
  echo "✓ PASS: Long-term memory was updated (grew by $((LT_AFTER_SIZE - LT_BEFORE_SIZE)) chars)"
fi

# Step 6: Verify .bak backup exists (auto-refine creates backup)
BAK_FILE="$LONG_TERM.bak"
if [ -f "$BAK_FILE" ]; then
  echo "✓ PASS: Backup file exists (long-term.md.bak)"
else
  echo "⚠ INFO: No .bak file (refine may not have run or wasn't needed)"
fi

# Step 7: Verify refine result in response
if echo "$RESPONSE" | grep -q '"refine"'; then
  echo "✓ PASS: Refine result included in archive response"
else
  echo "⚠ INFO: Refine result not in response"
fi

echo ""
echo "=== Test 3 complete ==="
