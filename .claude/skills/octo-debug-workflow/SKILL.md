---
name: octo-debug-workflow
description: "通用工作流调试流程 — 创建测试工作流、清理数据、重建、执行、监控验证"
category: debugging
tags: [engine, workflow, debugging, testing]
version: 1.0.0
---

# 通用工作流调试流程

## 触发条件
当需要端到端验证工作流行为时使用：新功能测试、bug 复现、修复验证、性能测试。
适用于任何节点类型：agent / bash / loop / swarm / sub_workflow / dynamic_sub_workflow / interaction 等。

## 调试 5 步法

### Step 1: 准备 — 创建最小化测试工作流

在目标 workspace 的 `workflows/` 目录创建测试工作流。

**原则**：
- 最小化复现：只保留触发目标行为的节点
- 用 mock 数据代替真实依赖（bash 节点创建假文件、agent 节点输出模拟结果）
- 覆盖关键路径：正常路径 + 边界条件 + 错误路径

```yaml
# 模板: test-{feature}.yaml
apiVersion: octopus/v1
kind: Workflow
name: test-{feature}
engine: claude
model: pro-max
timeout: 3600
execution_mode: serial

inputs:
  test_input:
    description: "测试输入"
    required: false
    default: "test"

variables:
  status: ""

nodes:
  - id: setup
    type: bash
    bash: |
      # 创建 mock 数据
      echo "Setup complete"

  - id: target-node
    type: {目标节点类型}
    depends_on: [setup]
    # ... 目标节点配置

  - id: verify
    type: bash
    depends_on: [target-node]
    bash: |
      echo "Verification complete"
```

### Step 2: 清理 — 移除旧执行数据

每次调试前必须清理，避免旧数据干扰。

```bash
WORKSPACE="/Users/xzf/.octopus/orgs/{org}/workspaces/{workspace}"
EXEC_ID="{previous-exec-id}"  # 从 DB 或 UI 获取

# 2a: 清理文件系统
rm -rf "$WORKSPACE/logs/"*
rm -rf "$WORKSPACE/state/"*
find "$WORKSPACE/workflows/" -name "workflow__*" -delete  # 动态生成的子工作流
find "$WORKSPACE/workflows/" -name "*.meta.json" -delete

# 2b: 清理数据库
sqlite3 ~/.octopus/db/octopus.db "
DELETE FROM agent_events WHERE node_execution_id LIKE '%${EXEC_ID}%';
DELETE FROM node_token_usages WHERE node_execution_id LIKE '%${EXEC_ID}%';
DELETE FROM node_executions WHERE execution_id = '${EXEC_ID}';
DELETE FROM executions WHERE id = '${EXEC_ID}';
"

# 2c: 清理 .scratch 目录（如有）
rm -rf .scratch/test-*/
```

**注意**：如果改了引擎代码，清理后还需重建。

### Step 3: 重建 — 编译变更 + 重启服务

```bash
# 3a: 重建改动的包
pnpm build --filter @octopus/engine    # 引擎变更
pnpm build --filter @octopus/server    # 服务端变更
pnpm build --filter @octopus/shared    # 共享包变更

# 3b: 重启 server（server 不使用 hot reload）
kill $(pgrep -f "packages/server/dist/index.js")
sleep 1
node packages/server/dist/index.js &
sleep 2

# 3c: 验证服务就绪
curl -s http://localhost:3001/api/workspaces | python3 -c "
import sys,json; d=json.load(sys.stdin); print(f'Server OK: {len(d)} workspaces')
"

# 3d: 前端 web-app 使用 Next.js dev server，支持 hot reload
#     如果改了前端代码，Cmd+Shift+R 硬刷新浏览器
```

### Step 4: 启动 — 创建执行并运行

```bash
WS_ID="{workspace-id}"  # 从 DB 或 UI 获取

# 4a: 创建执行
EXEC=$(curl -s -X POST "http://localhost:3001/api/workspaces/$WS_ID/executions" \
  -H "Content-Type: application/json" \
  -d '{"workflow_ref": "test-{feature}.yaml", "input_values": {"test_input": "value"}}')
EXEC_ID=$(echo "$EXEC" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Execution: $EXEC_ID"

# 4b: 启动执行（后台运行）
curl -s -X POST "http://localhost:3001/api/workspaces/$WS_ID/executions/$EXEC_ID/start" &

# 4c: 或直接通过 UI 操作
#     http://localhost:3000/workspaces/{wsId}?tab=execution
```

### Step 5: 监控验证 — 多维度检查

#### 5a: 执行状态轮询

```bash
# 轮询直到完成
for i in $(seq 1 30); do
  RESULT=$(curl -s "http://localhost:3001/api/workspaces/$WS_ID/executions/$EXEC_ID" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"status\",\"?\")}|{d.get(\"progress\",0)}')")
  echo "[$i] $RESULT"
  echo "$RESULT" | grep -qE "completed|failed" && break
  sleep 10
done
```

#### 5b: 日志文件检查

```bash
# 主日志目录
ls "$WORKSPACE/logs/$EXEC_ID/"

# 子工作流日志（如有 dynamic_sub_workflow / sub_workflow）
ls "$WORKSPACE/logs/" | grep "$EXEC_ID-"

# 查看特定节点的 JSONL 日志
cat "$WORKSPACE/logs/$EXEC_ID/{nodeId}.jsonl" | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    print(f'{d.get(\"event\",\"?\"):20} | {str(d.get(\"content\",\"\"))[:80]}')
"
```

#### 5c: API 事件验证

```bash
# 检查所有节点的事件分布
curl -s "http://localhost:3001/api/workspaces/$WS_ID/executions/$EXEC_ID/agent-events" | \
  python3 -c "
import sys, json
from collections import defaultdict
data = json.load(sys.stdin)
print(f'Source: {data.get(\"source\")}  Events: {len(data[\"events\"])}')
groups = defaultdict(list)
for e in data['events']:
    groups[e.get('nodeId','?')].append(e.get('event','?'))
for nid in sorted(groups):
    types = {}
    for ev in groups[nid]:
        types[ev] = types.get(ev, 0) + 1
    print(f'  {nid:40} → {len(groups[nid]):3} events: {dict(sorted(types.items()))}')
"
```

#### 5d: 并行执行验证

对于 DAG 中的并行节点，比较时间戳：

```bash
LOGDIR="$WORKSPACE/logs/$EXEC_ID"  # 或子工作流目录
for node in node-a node-b node-c; do
  python3 -c "
import json
lines = open('$LOGDIR/$node.jsonl').readlines()
s, e = json.loads(lines[0]), json.loads(lines[-1])
print(f'$node: start={s[\"timestamp\"][-12:]}  dur={e.get(\"durationMs\",\"?\")}ms  status={e[\"status\"]}')
"
done
# 验证：无依赖的节点 start 时间应几乎相同（差 < 50ms）
```

#### 5e: 前端渲染验证

1. 打开 `http://localhost:3000/workspaces/{wsId}?tab=execution`
2. 检查 DAG 图：所有节点状态正确（completed/failed/skipped）
3. 检查日志面板：每个节点组的事件数量和内容正确
4. 展开事件组：thinking_block / text_block / tool_call 内容可读

## 常用诊断查询

```bash
# 查看 node_executions 状态
sqlite3 ~/.octopus/db/octopus.db "
SELECT node_id, node_type, status, duration_ms
FROM node_executions WHERE execution_id = '$EXEC_ID' ORDER BY created_at
"

# 查看 agent_events 分布
sqlite3 ~/.octopus/db/octopus.db "
SELECT node_execution_id, event_type, count(*)
FROM agent_events WHERE node_execution_id LIKE '%${EXEC_ID}%'
GROUP BY node_execution_id, event_type ORDER BY node_execution_id
"

# 查看 loop 迭代信息
curl -s "http://localhost:3001/api/workspaces/$WS_ID/executions/$EXEC_ID/agent-events" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('loopIterations',{}), indent=2))"
```

## 常见问题速查

| 现象 | 可能原因 | 排查 |
|------|---------|------|
| 节点不执行 | 缺少 `depends_on` | 检查 DAG 完整性 |
| 子工作流文件被覆盖 | loop 未传 `iterationIndex` | 检查 `loop.ts` createExecutor |
| 前端日志只显示摘要 | 子引擎日志在独立目录 | 检查 `logs/{execId}-workflow__*/` |
| 前端事件数量不对 | 分组 key 不匹配 | 对比 API 返回 vs 前端分组 |
| 执行卡在某个节点 | agent 超时或等待 approval | 检查该节点 JSONL 最后一条 |
| 变量未传递 | `$vars.xxx` 拼写或 VarPool 未 set | 检查 `execution.jsonl` 的 vars_update |
