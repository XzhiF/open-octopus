#!/bin/bash
# Test: intervention chat result should appear in agent-events API
set -e

WS_ID="ad18c087-58dc-42d1-9657-ae868204c2c5"
SERVER="http://localhost:3001"
WORKFLOW="observability-full-test.yaml"

echo "=== Test: Intervention Chat Result Persistence ==="

# Step 1: Create execution
echo "[1] Creating execution..."
CREATE_RESP=$(curl -s -X POST "$SERVER/api/workspaces/$WS_ID/executions" \
  -H "Content-Type: application/json" \
  -d "{\"workflow_ref\": \"$WORKFLOW\"}")
EXEC_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
echo "    Execution ID: $EXEC_ID"

if [ -z "$EXEC_ID" ]; then
  echo "FAIL: Could not create execution"
  echo "Response: $CREATE_RESP"
  exit 1
fi

# Step 2: Start execution
echo "[2] Starting execution..."
curl -s -X POST "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID/start" \
  -H "Content-Type: application/json" -d '{}' > /dev/null
echo "    Started. Waiting for code-analysis node to run..."
sleep 15

# Step 3: Send intervention message
echo "[3] Sending intervention message..."
INTERVENE_RESP=$(curl -s -X POST "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID/harness-intervene" \
  -H "Content-Type: application/json" \
  -d "{
    \"nodeId\": \"code-analysis\",
    \"directive\": {
      \"type\": \"inject\",
      \"reason\": \"test intervention\",
      \"issued_by\": \"test\",
      \"message\": \"没项目，没代码，直接结束。\"
    }
  }")
echo "    Response: $INTERVENE_RESP"

# Step 4: Wait for intervention result (the engine processes it async)
echo "[4] Waiting for intervention result to be stored..."
sleep 20

# Step 5: Check agent-events API
echo "[5] Checking agent-events API..."
EVENTS=$(curl -s "$SERVER/api/workspaces/$WS_ID/executions/$EXEC_ID/agent-events")

python3 -c "
import sys, json

data = json.loads('''$EVENTS''') if '''$EVENTS''' else {}
events = data.get('events', [])

# Check for harness_user_message
user_msgs = [e for e in events if e.get('event') == 'harness_user_message']
print(f'  harness_user_message events: {len(user_msgs)}')
for m in user_msgs:
    content = m.get('data', {}).get('content', '')
    print(f'    Content: {content[:80]}')

# Check for harness_system_response
sys_msgs = [e for e in events if e.get('event') == 'harness_system_response']
print(f'  harness_system_response events: {len(sys_msgs)}')
for m in sys_msgs:
    content = m.get('data', {}).get('content', '')
    print(f'    Content: {content[:80]}')

# Check for intervention_result
results = [e for e in events if e.get('event') == 'intervention_result']
print(f'  intervention_result events: {len(results)}')
for r in results:
    result = r.get('data', {}).get('result', '')
    print(f'    Result: {result[:120]}')

# Assertions
errors = []
if len(user_msgs) == 0:
    errors.append('No harness_user_message found in agent-events')
if len(results) == 0:
    errors.append('No intervention_result found in agent-events — the LLM reply is missing!')
else:
    for r in results:
        result_text = r.get('data', {}).get('result', '')
        if not result_text:
            errors.append('intervention_result has empty result text!')

if errors:
    print()
    print('=== FAILURES ===')
    for e in errors:
        print(f'  ✗ {e}')
    sys.exit(1)
else:
    print()
    print('=== ALL CHECKS PASSED ===')
    sys.exit(0)
" 2>&1 || {
  echo "Python parse error, raw events response:"
  echo "$EVENTS" | head -c 2000
  exit 1
}
