#!/bin/bash
# E2E Test 2: Verify scheduler seed — system:daily-archive task exists
# Prerequisite: Server running on port 3001

set -e
BASE_URL="http://localhost:3001/api"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"

echo "=== Test 2: Verify scheduler seed ==="

# Step 1: Query scheduler jobs
echo "  Querying scheduler jobs at GET /api/scheduler/jobs..."
RESPONSE=$(curl -s "$BASE_URL/scheduler/jobs" \
  -H "$AUTH" -H "$ORG")

echo "  Response (first 500 chars): $(echo "$RESPONSE" | head -c 500)"

# Step 2: Check if system:daily-archive exists
if echo "$RESPONSE" | grep -q "system:daily-archive"; then
  echo "PASS: system:daily-archive task found in scheduler jobs"
else
  echo "FAIL: system:daily-archive task NOT found"
  exit 1
fi

# Step 3: Verify cron expression
if echo "$RESPONSE" | grep -q "0 3 \* \* \*"; then
  echo "PASS: Cron expression is '0 3 * * *' (daily at 3 AM)"
else
  echo "WARN: Cron expression may not match expected '0 3 * * *'"
  echo "  Full response: $RESPONSE"
fi

# Step 4: Verify timezone
if echo "$RESPONSE" | grep -q "Asia/Shanghai"; then
  echo "PASS: Timezone is Asia/Shanghai"
else
  echo "WARN: Timezone may not be Asia/Shanghai"
fi

# Step 5: Verify job_type is 'agent'
if echo "$RESPONSE" | grep -q '"job_type":"agent"'; then
  echo "PASS: job_type is 'agent'"
else
  echo "WARN: job_type may not be 'agent'"
fi

# Step 6: Verify enabled
if echo "$RESPONSE" | grep -q '"enabled":true'; then
  echo "PASS: Task is enabled"
else
  echo "WARN: Task may not be enabled"
fi

echo ""
echo "=== Test 2 complete ==="
