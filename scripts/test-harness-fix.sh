#!/bin/bash
# Test script for harness block_node + continueSubsequent fix
# Creates execution → starts → polls → checks results

set -e
WS_ID="3a334720-689c-4392-b7c6-7d8d65b9f8b4"
SERVER="http://localhost:3001"
WORKFLOW="observability-full-test.yaml"

echo "=== Step 1: Clean previous data ==="
# No need to clean — each execution gets a unique ID

echo "=== Step 2: Create execution ==="
CREATE_RESP=$(curl -s -X POST "$SERVER/api/workspaces/$WS_ID/executions" \
  -H "Content-Type: application/json" \
  -d "{\"workflow_ref\": \"$WORKFLOW\"}")
EXEC_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
echo "Execution ID: $EXEC_ID"

if [ -z "$EXEC_ID" ]; then
  echo "FAIL: Could not create execution"
  echo "Response: $CREATE_RESP"
  exit 1
fi

echo "=== Step 3: Start execution ==="
curl -s -X POST "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID/start" \
  -H "Content-Type: application/json" -d '{}' > /dev/null
echo "Started. Polling..."

echo "=== Step 4: Wait for completion ==="
MAX_WAIT=180  # 3 minutes max
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(curl -s "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))")

  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "completed_with_failures" ] || \
     [ "$STATUS" = "failed" ] || [ "$STATUS" = "cancelled" ]; then
    echo "Execution finished: $STATUS (${ELAPSED}s)"
    break
  fi
  echo "  [$ELAPSED s] status=$STATUS"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "TIMEOUT after ${MAX_WAIT}s"
fi

echo ""
echo "=== Step 5: Check results ==="
curl -s "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID" | python3 -c "
import sys, json

data = json.load(sys.stdin)
status = data.get('status', 'unknown')
steps = data.get('steps', [])

print(f'Execution status: {status}')
print()
print(f'{\"Node\":<20} {\"Status\":<12} {\"Harness\":<15}')
print('-' * 50)

skipped_count = 0
failed_count = 0
completed_count = 0

for s in steps:
    node_id = s.get('stepId', '?')
    node_status = s.get('status', '?')
    harness = s.get('harnessStatus', '')
    print(f'{node_id:<20} {node_status:<12} {harness:<15}')

    if node_status == 'skipped':
        skipped_count += 1
    elif node_status == 'failed':
        failed_count += 1
    elif node_status == 'completed':
        completed_count += 1

print()
print(f'Summary: {completed_count} completed, {failed_count} failed, {skipped_count} skipped')
print()

# Assertions
errors = []

# 1. Execution should NOT be 'completed' if there are many skipped nodes
if status == 'completed' and skipped_count > 2:
    errors.append(f'BUG: status=completed but {skipped_count} nodes skipped — should be completed_with_failures or failed')

# 2. run-tests should be failed (harness blocked)
run_tests = next((s for s in steps if s.get('stepId') == 'run-tests'), None)
if run_tests:
    if run_tests.get('status') != 'failed':
        errors.append(f'BUG: run-tests status={run_tests.get(\"status\")} — expected failed')
    if run_tests.get('harnessStatus') != 'harness_blocked':
        errors.append(f'BUG: run-tests harnessStatus={run_tests.get(\"harnessStatus\")} — expected harness_blocked')

# 3. fix-suggestion should execute (not skip) if continueSubsequent works
fix = next((s for s in steps if s.get('stepId') == 'fix-suggestion'), None)
if fix:
    if fix.get('status') == 'skipped':
        errors.append(f'BUG: fix-suggestion was skipped — continueSubsequent not working')

if errors:
    print('=== FAILURES ===')
    for e in errors:
        print(f'  ✗ {e}')
    sys.exit(1)
else:
    print('=== ALL CHECKS PASSED ===')
    sys.exit(0)
"
