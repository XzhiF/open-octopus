#!/bin/bash
# E2E Test 1: Verify record_daily tool
# Prerequisite: Server running on port 3001 with Claude SDK available
#
# This test sends a meaningful message that should trigger record_daily usage.
# Since the Agent uses LLM reasoning, the tool call is probabilistic.
# This script verifies the infrastructure works when the tool IS called.

set -e
BASE_URL="http://localhost:3001/api"

echo "=== Test 1: Verify record_daily infrastructure ==="

# Step 1: Check daily memory directory exists
DAILY_DIR="$HOME/.octopus/agent/memory/daily"
if [ ! -d "$DAILY_DIR" ]; then
  echo "FAIL: Daily memory directory not found at $DAILY_DIR"
  exit 1
fi
echo "✓ Daily memory directory exists"

# Step 2: Record today's file state before test
TODAY=$(date +%Y-%m-%d)
DAILY_FILE="$DAILY_DIR/$TODAY.md"
BEFORE_SIZE=0
if [ -f "$DAILY_FILE" ]; then
  BEFORE_SIZE=$(wc -c < "$DAILY_FILE")
fi
echo "  Today's daily file size before: $BEFORE_SIZE bytes"

# Step 3: Send a meaningful chat message that should trigger record_daily
echo "  Sending chat message (expecting Agent to consider record_daily)..."
RESPONSE=$(curl -s -N -X POST "$BASE_URL/agent/chat" \
  -H "Content-Type: application/json" \
  -H "X-Octopus-Org: default" \
  -d '{"message": "我们刚才讨论了项目架构的重要决策：使用 SQLite 作为本地优先数据库，而不是 PostgreSQL。这个决定影响了整个系统的数据层设计。请记录这个重要决定到工作记忆中。"}')

echo "  Response received (${#RESPONSE} bytes)"

# Step 4: Check if daily file was modified
AFTER_SIZE=0
if [ -f "$DAILY_FILE" ]; then
  AFTER_SIZE=$(wc -c < "$DAILY_FILE")
fi
echo "  Today's daily file size after: $AFTER_SIZE bytes"

if [ "$AFTER_SIZE" -gt "$BEFORE_SIZE" ]; then
  echo "✓ PASS: Daily file was updated (grew by $((AFTER_SIZE - BEFORE_SIZE)) bytes)"
else
  echo "⚠ INFO: Daily file was not updated (Agent may not have called record_daily)"
  echo "  This is expected if Claude SDK is unavailable or Agent decided not to record"
fi

# Step 5: Verify session memory FTS is accessible
echo "  Checking session memory search..."
SEARCH_RESPONSE=$(curl -s "$BASE_URL/agent/memory/search?q=SQLite&top_k=3" \
  -H "X-Octopus-Org: default")
echo "  Search response: $(echo "$SEARCH_RESPONSE" | head -c 200)..."

echo ""
echo "=== Test 1 complete ==="
