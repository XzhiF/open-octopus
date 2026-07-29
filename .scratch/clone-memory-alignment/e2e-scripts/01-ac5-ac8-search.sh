#!/bin/bash
# E2E Test: AC5 & AC8 — Memory search with source filter
# AC5: GET /memory/search returns clone-written records with correct source field
# AC8: GET /memory/search?source=clone-name returns only that clone's records

set -e

BASE_URL="http://localhost:3001/api/agent"
AUTH="Authorization: Bearer e2e-test-token"
ORG="X-Octopus-Org: xzf"
CLONE_NAME="E2E_TEST_clone"

echo "=== AC5 & AC8: Memory Search Source Filter Test ==="
echo ""

# First, rebuild FTS index to ensure test data is indexed
echo "[Step 1] Rebuilding FTS index..."
REBUILD_RESP=$(curl -s -X POST "$BASE_URL/memory/rebuild-fts" -H "$AUTH" -H "$ORG")
echo "Rebuild response: $REBUILD_RESP"
echo ""

# AC5: Search without source filter — should return both main and clone results
echo "[Step 2] AC5: Search without source filter (q=E2E_TEST)..."
SEARCH_ALL=$(curl -s "$BASE_URL/memory/search?q=E2E_TEST&top_k=10" -H "$AUTH" -H "$ORG")
echo "Search all response:"
echo "$SEARCH_ALL" | python3 -m json.tool 2>/dev/null || echo "$SEARCH_ALL"
echo ""

# Verify: results should contain entries
ALL_COUNT=$(echo "$SEARCH_ALL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null || echo "0")
echo "Total results found: $ALL_COUNT"

if [ "$ALL_COUNT" -gt "0" ]; then
  echo "[AC5] PASS — Search returned $ALL_COUNT results"
else
  echo "[AC5] FAIL — Search returned 0 results"
fi
echo ""

# Check source field in results
HAS_SOURCE=$(echo "$SEARCH_ALL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
for r in results:
    if 'source' in r:
        print('yes')
        break
else:
    print('no')
" 2>/dev/null || echo "unknown")
echo "Source field present in results: $HAS_SOURCE"
echo ""

# AC8: Search with source=clone-name — should return ONLY clone results
echo "[Step 3] AC8: Search with source=$CLONE_NAME..."
SEARCH_CLONE=$(curl -s "$BASE_URL/memory/search?q=E2E_TEST&source=$CLONE_NAME&top_k=10" -H "$AUTH" -H "$ORG")
echo "Search clone response:"
echo "$SEARCH_CLONE" | python3 -m json.tool 2>/dev/null || echo "$SEARCH_CLONE"
echo ""

# Verify: all results should have source=E2E_TEST_clone
CLONE_ONLY=$(echo "$SEARCH_CLONE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
all_clone = all(r.get('source') == '$CLONE_NAME' for r in results)
print('PASS' if all_clone and len(results) > 0 else 'FAIL')
print(f'Count: {len(results)}')
for r in results:
    print(f'  source={r.get(\"source\", \"MISSING\")}')
" 2>/dev/null || echo "FAIL")
echo "Clone-only filter result: $CLONE_ONLY"
echo ""

# AC8b: Search with source=main — should return ONLY main results
echo "[Step 4] AC8b: Search with source=main..."
SEARCH_MAIN=$(curl -s "$BASE_URL/memory/search?q=E2E_TEST&source=main&top_k=10" -H "$AUTH" -H "$ORG")
echo "Search main response:"
echo "$SEARCH_MAIN" | python3 -m json.tool 2>/dev/null || echo "$SEARCH_MAIN"
echo ""

MAIN_ONLY=$(echo "$SEARCH_MAIN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
all_main = all(r.get('source') == 'main' for r in results)
print('PASS' if all_main else 'FAIL')
print(f'Count: {len(results)}')
for r in results:
    print(f'  source={r.get(\"source\", \"MISSING\")}')
" 2>/dev/null || echo "FAIL")
echo "Main-only filter result: $MAIN_ONLY"
echo ""

echo "=== AC5 & AC8 Test Complete ==="
