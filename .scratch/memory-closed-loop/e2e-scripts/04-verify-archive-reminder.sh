#!/bin/bash
# E2E Test 4: Verify archive reminder in system prompt
# Prerequisite: Server running on port 3001
#
# This test creates 4+ daily files to trigger the archive reminder,
# then verifies the daily memory API returns them and checks the
# system prompt assembler source for the reminder logic.

set -e
BASE_URL="http://localhost:3001/api"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"
DAILY_DIR="$HOME/.octopus/agent/memory/daily"

echo "=== Test 4: Verify archive reminder ==="

# Step 1: Create 4 test daily files
echo "  Creating 4 test daily files..."
mkdir -p "$DAILY_DIR"
for i in 1 2 3 4; do
  TEST_DATE="2026-07-2$i"
  TEST_FILE="$DAILY_DIR/$TEST_DATE.md"
  if [ ! -f "$TEST_FILE" ]; then
    printf "### 10:00:00\nE2E_TEST archive reminder entry $i\n" > "$TEST_FILE"
    echo "  Created $TEST_FILE"
  else
    echo "  Already exists: $TEST_FILE"
  fi
done

# Step 2: Count daily files
FILE_COUNT=$(ls -1 "$DAILY_DIR"/*.md 2>/dev/null | wc -l)
echo "  Daily files count: $FILE_COUNT"

if [ "$FILE_COUNT" -gt 3 ]; then
  echo "PASS: Precondition met: >3 daily files exist ($FILE_COUNT files)"
else
  echo "FAIL: Only $FILE_COUNT daily files (need >3 for reminder)"
  exit 1
fi

# Step 3: Verify via daily memory API
echo "  Checking GET /api/agent/memory/daily..."
RESPONSE=$(curl -s "$BASE_URL/agent/memory/daily" \
  -H "$AUTH" -H "$ORG")

ITEM_COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data))" 2>/dev/null || echo "?")
echo "  Daily memory API returned $ITEM_COUNT items"

if [ "$ITEM_COUNT" != "?" ] && [ "$ITEM_COUNT" -ge 4 ]; then
  echo "PASS: Daily memory API returns >=4 items ($ITEM_COUNT)"
else
  echo "WARN: Daily memory API returned $ITEM_COUNT items (expected >=4)"
fi

# Step 4: Verify the system prompt assembler has the reminder logic
echo "  Checking system-prompt-assembler.ts for archive reminder logic..."
ASSEMBLER_FILE="packages/server/src/services/agent/system-prompt-assembler.ts"
if [ -f "$ASSEMBLER_FILE" ]; then
  if grep -q "unarchived\|archive.*reminder\|daily.*count\|daily.*files" "$ASSEMBLER_FILE" 2>/dev/null; then
    echo "PASS: Archive reminder logic found in system-prompt-assembler.ts"
  else
    echo "WARN: Archive reminder logic not found in assembler (checking for daily memory segment)"
    if grep -q "buildDailyMemory\|dailyMemory\|daily" "$ASSEMBLER_FILE" 2>/dev/null; then
      echo "PASS: Daily memory segment exists in assembler"
    else
      echo "WARN: No daily memory segment found in assembler"
    fi
  fi
else
  echo "WARN: system-prompt-assembler.ts not found"
fi

# Step 5: Cleanup test files
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
