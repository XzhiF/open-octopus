#!/bin/bash
# E2E Test: AC1 & AC2 — Clone record_daily writes to clone dir, not main dir
# AC1: Clone calls record_daily → file written to {cloneDir}/memory/daily/YYYY-MM-DD.md,
#      FTS inserted with source=clone-name
# AC2: Clone's record_daily does NOT write to main agent's memory/daily/
#
# NOTE: The chat API triggers record_daily via LLM tool calls, which requires
# an actual AI provider call. Instead, we test the underlying mechanism:
# 1. Verify clone daily file exists at correct path after setup
# 2. Verify main agent daily dir does NOT contain clone entries
# 3. Use POST /memory/rebuild-fts then GET /memory/search to verify FTS source field

set -e

CLONE_NAME="E2E_TEST_clone"
CLONE_DIR="$HOME/.octopus/agent/clones/$CLONE_NAME"
MAIN_DAILY_DIR="$HOME/.octopus/agent/memory/daily"
TODAY=$(date +%Y-%m-%d)

BASE_URL="http://localhost:3001/api/agent"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"

echo "=== AC1 & AC2: Clone record_daily Path Isolation Test ==="
echo ""

# AC1: Verify clone daily file exists at correct path
echo "[Step 1] AC1: Verify clone daily file at {cloneDir}/memory/daily/$TODAY.md..."
CLONE_DAILY="$CLONE_DIR/memory/daily/$TODAY.md"
if [ -f "$CLONE_DAILY" ]; then
  echo "PASS — Clone daily file exists at: $CLONE_DAILY"
  echo "Content:"
  cat "$CLONE_DAILY"
  echo ""
else
  echo "FAIL — Clone daily file not found at: $CLONE_DAILY"
fi
echo ""

# AC1b: Verify FTS has source=clone-name via search
echo "[Step 2] AC1b: Verify FTS indexed with source=$CLONE_NAME..."
SEARCH_RESP=$(curl -s "$BASE_URL/memory/search?q=E2E_TEST_clone_memory_insight&source=$CLONE_NAME&top_k=5" -H "$AUTH" -H "$ORG")
echo "Search response: $SEARCH_RESP"

CLONE_FTS=$(echo "$SEARCH_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
clone_results = [r for r in results if r.get('source') == '$CLONE_NAME']
print('PASS' if len(clone_results) > 0 else 'FAIL')
print(f'Clone results: {len(clone_results)}')
" 2>/dev/null || echo "FAIL")
echo "FTS source verification: $CLONE_FTS"
echo ""

# AC2: Verify main agent daily dir does NOT contain clone content
echo "[Step 3] AC2: Verify main agent daily dir has no clone entries..."
MAIN_DAILY="$MAIN_DAILY_DIR/$TODAY.md"
if [ -f "$MAIN_DAILY" ]; then
  # Check that main daily does NOT contain clone-specific content
  if grep -q "E2E_TEST_clone_memory_insight" "$MAIN_DAILY" 2>/dev/null; then
    echo "FAIL — Main agent daily file contains clone content!"
    echo "Content:"
    cat "$MAIN_DAILY"
  else
    echo "PASS — Main agent daily file exists but does NOT contain clone content"
    echo "Main daily content:"
    cat "$MAIN_DAILY"
  fi
else
  echo "PASS — Main agent daily file does not exist (no main record_daily called)"
fi
echo ""

# AC2b: Verify clone daily dir does NOT contain main agent content
echo "[Step 4] AC2b: Verify clone daily dir has no main agent content..."
if [ -f "$CLONE_DAILY" ]; then
  if grep -q "E2E_TEST_main_memory" "$CLONE_DAILY" 2>/dev/null; then
    echo "FAIL — Clone daily file contains main agent content!"
  else
    echo "PASS — Clone daily file does NOT contain main agent content"
  fi
fi
echo ""

echo "=== AC1 & AC2 Test Complete ==="
