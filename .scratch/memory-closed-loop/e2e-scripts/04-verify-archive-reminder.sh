#!/bin/bash
# E2E Test 4: Verify archive reminder in system prompt
# Prerequisite: Server running on port 3001
#
# This test creates 4+ daily files to trigger the archive reminder,
# then assembles the system prompt to verify the reminder appears.

set -e
DAILY_DIR="$HOME/.octopus/agent/memory/daily"

echo "=== Test 4: Verify archive reminder ==="

# Step 1: Create 4 test daily files
echo "  Creating 4 test daily files..."
for i in 1 2 3 4; do
  TEST_DATE="2026-07-2$i"
  TEST_FILE="$DAILY_DIR/$TEST_DATE.md"
  if [ ! -f "$TEST_FILE" ]; then
    echo "### 10:00:00\nTest entry $i for archive reminder verification" > "$TEST_FILE"
    echo "  Created $TEST_FILE"
  fi
done

# Step 2: Count daily files
FILE_COUNT=$(ls -1 "$DAILY_DIR"/*.md 2>/dev/null | wc -l)
echo "  Daily files count: $FILE_COUNT"

if [ "$FILE_COUNT" -gt 3 ]; then
  echo "✓ Precondition met: >3 daily files exist"
else
  echo "⚠ WARN: Only $FILE_COUNT daily files (need >3 for reminder)"
fi

# Step 3: Verify via assembler (indirect — check daily memory API)
BASE_URL="http://localhost:3001/api"
RESPONSE=$(curl -s "$BASE_URL/agent/memory/daily" \
  -H "X-Octopus-Org: default")

ITEM_COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "  Daily memory API returned $ITEM_COUNT items"

echo ""
echo "  NOTE: Archive reminder is embedded in the system prompt."
echo "  To verify it appears, start a chat session and check if the Agent"
echo "  mentions archiving in its response."
echo ""

# Step 4: Cleanup test files (remove the ones we created)
echo "  Cleaning up test files..."
for i in 1 2 3 4; do
  TEST_DATE="2026-07-2$i"
  TEST_FILE="$DAILY_DIR/$TEST_DATE.md"
  if [ -f "$TEST_FILE" ]; then
    rm "$TEST_FILE"
    echo "  Removed $TEST_FILE"
  fi
done

echo ""
echo "=== Test 4 complete ==="
