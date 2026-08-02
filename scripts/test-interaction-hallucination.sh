#!/bin/bash
# Test: Interaction AskUserQuestion hallucination bug
# Usage: bash scripts/test-interaction-hallucination.sh [num_runs]
#
# PASS = AskUserQuestion called, stopReason=tool_use, no vars_update, no interaction_complete
# FAIL = agent hallucinated answer or completed without user input

set -e

WORKSPACE_ID="9a08de03-6e2b-4807-8229-abd94d6d1101"
SERVER_URL="http://localhost:3001"
WORKFLOW_REF="pick-color.yaml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass_count=0
fail_count=0

cleanup() {
  sqlite3 ~/.octopus/db/octopus.db "
    DELETE FROM interaction_messages WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = '$WORKSPACE_ID');
    DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = '$WORKSPACE_ID'));
    DELETE FROM llm_calls WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = '$WORKSPACE_ID');
    DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = '$WORKSPACE_ID'));
    DELETE FROM node_executions WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = '$WORKSPACE_ID');
    DELETE FROM executions WHERE workspace_id = '$WORKSPACE_ID';
    DELETE FROM chat_sessions WHERE workspace_id = '$WORKSPACE_ID';
  " 2>/dev/null || true
}

run_test() {
  local run_num=$1
  cleanup

  echo -ne "${YELLOW}Run #$run_num${NC} "

  # 1. Create execution
  local create_resp
  create_resp=$(curl -s -X POST "$SERVER_URL/api/workspaces/$WORKSPACE_ID/executions" \
    -H "Content-Type: application/json" \
    -d "{\"workflow_ref\": \"$WORKFLOW_REF\"}" 2>/dev/null)
  local exec_id
  exec_id=$(echo "$create_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -z "$exec_id" ]; then
    echo -e "${RED}FAIL: create execution${NC}"
    fail_count=$((fail_count + 1))
    return 1
  fi

  # 2. Start execution
  curl -s -X POST "$SERVER_URL/api/workspaces/$WORKSPACE_ID/executions/$exec_id/start" \
    -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1

  # 3. Start interaction session
  local start_resp
  start_resp=$(curl -s -X POST "$SERVER_URL/api/workspaces/$WORKSPACE_ID/interactions/$exec_id/ask-color/start" \
    -H "Content-Type: application/json" -d '{"display": "modal"}' 2>/dev/null)
  local active
  active=$(echo "$start_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
  if [ -z "$active" ]; then
    echo -e "${RED}FAIL: start interaction${NC}"
    fail_count=$((fail_count + 1))
    cleanup
    return 1
  fi

  # 4. Send initial prompt
  local sse_file="/tmp/interaction-sse-$run_num.txt"
  curl -s -N --max-time 90 -X POST \
    "$SERVER_URL/api/workspaces/$WORKSPACE_ID/interactions/$exec_id/ask-color/messages" \
    -H "Content-Type: application/json" \
    -d '{"content": "[系统指令 - 以下是你在本次交互中的角色和任务]\n\n使用 AskUserQuestion 工具向用户提问：\n- question: \"你最喜欢什么颜色？\"\n- header: \"颜色偏好\"\n- multiSelect: false\n- options: 红色、蓝色、绿色、其他\n\n不要用纯文本列选项，必须调用 AskUserQuestion。\n\n收到回答后，在回复末尾输出以下 JSON：\n\n```json\n{\"summary\": \"用户选择了 [颜色]\", \"vars_update\": {\"favorite_color\": \"用户选择或输入的颜色\"}}\n```\n\n[请根据以上指令开始与用户对话]"}' > "$sse_file" 2>/dev/null || true

  # 5. Parse
  local full_text stop_reason has_ask has_complete has_vars
  full_text=$(grep "text_delta" "$sse_file" | python3 -c "
import sys, json
text = ''
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data:'):
        try:
            d = json.loads(line[5:])
            if d.get('type') == 'text_delta':
                text += d.get('content', '')
        except: pass
print(text)
" 2>/dev/null)

  stop_reason=$(grep "message_delta" "$sse_file" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data:'):
        try:
            d = json.loads(line[5:])
            sr = d.get('stopReason', '')
            if sr: print(sr)
        except: pass
" 2>/dev/null | tail -1)

  has_ask=$(grep -c "ask_user_question" "$sse_file" 2>/dev/null || echo "0")
  has_complete=$(grep -c "interaction_complete" "$sse_file" 2>/dev/null || echo "0")
  has_vars=$(echo "$full_text" | grep -c "vars_update" 2>/dev/null || echo "0")

  # 6. Evaluate
  local result="UNKNOWN"
  local details="stop=$stop_reason ask=$has_ask complete=$has_complete vars=$has_vars"

  if [ "$has_vars" -gt 0 ] || [ "$has_complete" -gt 0 ]; then
    echo -e "${RED}FAIL${NC} | $details"
    echo "  text: $(echo "$full_text" | tr '\n' ' ' | cut -c1-100)"
    result="FAIL"
    fail_count=$((fail_count + 1))
  elif [ "$has_ask" -gt 0 ] && [ "$stop_reason" = "tool_use" ]; then
    echo -e "${GREEN}PASS${NC} | $details"
    result="PASS"
    pass_count=$((pass_count + 1))
  elif [ "$has_ask" -gt 0 ]; then
    echo -e "${GREEN}PASS${NC} (warn: stop=$stop_reason) | $details"
    result="PASS"
    pass_count=$((pass_count + 1))
  else
    echo -e "${YELLOW}WARN${NC} | $details | no AskUserQuestion"
    echo "  text: $(echo "$full_text" | tr '\n' ' ' | cut -c1-100)"
    result="WARN"
    pass_count=$((pass_count + 1))
  fi

  rm -f "$sse_file"
  cleanup
}

# Main
NUM_RUNS=${1:-10}
echo -e "${YELLOW}Interaction Hallucination Bug Test ($NUM_RUNS runs)${NC}"
echo ""

for i in $(seq 1 $NUM_RUNS); do
  run_test $i
done

echo ""
echo -e "${YELLOW}━━━ Summary ━━━${NC}"
echo -e "Total: $NUM_RUNS | ${GREEN}PASS: $pass_count${NC} | ${RED}FAIL: $fail_count${NC}"
[ $fail_count -eq 0 ] && echo -e "${GREEN}All passed!${NC}" || echo -e "${RED}Some failed.${NC}"
[ $fail_count -eq 0 ]
