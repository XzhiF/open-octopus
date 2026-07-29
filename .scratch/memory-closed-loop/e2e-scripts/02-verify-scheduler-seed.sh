#!/bin/bash
# E2E Test 2: Verify scheduler seed — system:daily-archive task exists
# Prerequisite: Server running on port 3001

set -e
BASE_URL="http://localhost:3001/api"

echo "=== Test 2: Verify scheduler seed ==="

# Step 1: Query scheduler jobs
echo "  Querying scheduler jobs..."
RESPONSE=$(curl -s "$BASE_URL/scheduler/jobs" \
  -H "X-Octopus-Org: default")

# Step 2: Check if system:daily-archive exists
if echo "$RESPONSE" | grep -q "system:daily-archive"; then
  echo "✓ PASS: system:daily-archive task found in scheduler jobs"
else
  echo "✗ FAIL: system:daily-archive task NOT found"
  echo "  Response: $(echo "$RESPONSE" | head -c 500)"
  exit 1
fi

# Step 3: Verify cron expression
if echo "$RESPONSE" | grep -q "0 3 \* \* \*"; then
  echo "✓ PASS: Cron expression is '0 3 * * *' (daily at 3 AM)"
else
  echo "⚠ WARN: Cron expression may not match expected '0 3 * * *'"
fi

echo ""
echo "=== Test 2 complete ==="
