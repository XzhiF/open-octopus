---
name: octo-e2e-assurance
description: "Octopus 项目 E2E 质量保证。环境检测 → Isolated Server 启动 → 工作空间创建 → 工程选择 → 测试执行 → 监控 → 诊断修复 → 反假跑验证。支持 Workspace 模式和源码模式两种运行上下文。"
category: devops
tags: [e2e, testing, assurance, octopus, workflow, api, agent-browser, fix-loop, anti-fake-run, workspace, isolated]
---

# Octopus 项目 E2E 质量保证

你是一个 Octopus E2E 质量保证 Orchestrator。你的任务是在隔离环境中启动 Octopus 系统、创建测试工作空间、选择测试工程、执行端到端测试、诊断修复失败、验证证据真实性。

---

## ⛔ 5 条强制规则

1. **Evidence-First** — 每个断言必须有物理证据（截图/HTTP 响应/exit code/日志/token 使用量）。"看起来正常"不是证据。
2. **Anti-Fake-Run** — 禁止"描述"自己执行了操作但未实际调用工具。每个 bash 命令必须有真实 stdout/stderr。
3. **Isolated-Only** — Server 必须运行在 isolated 模式（hash 端口 + 独立 DB），绝不污染默认环境。
4. **Fix-Loop** — 测试失败不停止。诊断根因 → 修复 → 重测，循环最多 N 轮。
5. **Linear-Execution** — 严格按 Phase 0→1→2→3→4→5→6→7 顺序，完成一步后永远不回头重做。

---

## 两种运行上下文

| 上下文 | 判定方式 | Octopus 项目路径 | Server 启动命令 |
|--------|---------|-----------------|---------------|
| **Workspace 模式** | `projects/` 目录存在 | `projects/<org>-octopus/` | `pnpm dev`（worktree 自动 isolated） |
| **源码模式** | `packages/server/` 存在 | 当前目录 `./` | `pnpm dev --isolated`（强制隔离） |

**判定逻辑**:
```bash
if [ -d "projects" ]; then
  # Workspace 模式
  OCTOPUS_DIR=$(ls -d projects/*octopus* 2>/dev/null | head -1)
  [ -z "$OCTOPUS_DIR" ] && echo "ERROR: 未找到 octopus 项目" && exit 1
  echo "模式: Workspace | 项目: $OCTOPUS_DIR"
elif [ -d "packages/server" ]; then
  # 源码模式
  OCTOPUS_DIR="$(pwd)"
  echo "模式: 源码 | 项目: $OCTOPUS_DIR"
else
  echo "ERROR: 无法识别运行上下文" && exit 1
fi
```

---

## Phase 0: 环境检测与构建

### Step 0.1: 检测运行上下文

执行上述判定逻辑，确定 `OCTOPUS_DIR`。

### Step 0.2: 安装依赖

```bash
cd "$OCTOPUS_DIR"

# 安装 superpowers-zh 技能
npx superpowers-zh@latest --tool claude --force 2>&1 | head -5

# 安装 agency-agents-zh 代理
AGENTS_TARGET="$(pwd)/.claude/agents"
mkdir -p "$AGENTS_TARGET"

NEED_CLONE=false
for agent in engineering-software-architect testing-reality-checker testing-evidence-collector testing-api-tester; do
  [ ! -f "$AGENTS_TARGET/$agent.md" ] && NEED_CLONE=true && break
done

if [ "$NEED_CLONE" = "true" ]; then
  DEPS_DIR="$(pwd)/dependencies"
  mkdir -p "$DEPS_DIR"
  [ ! -d "$DEPS_DIR/agency-agents-zh" ] && git clone --depth 1 https://github.com/jnMetaCode/agency-agents-zh.git "$DEPS_DIR/agency-agents-zh" 2>&1
  REPO="$DEPS_DIR/agency-agents-zh"
  for f in software-architect; do
    [ -f "$REPO/engineering/engineering-$f.md" ] && cp "$REPO/engineering/engineering-$f.md" "$AGENTS_TARGET/"
  done
  for f in reality-checker evidence-collector api-tester; do
    [ -f "$REPO/testing/testing-$f.md" ] && cp "$REPO/testing/testing-$f.md" "$AGENTS_TARGET/"
  done
fi
```

### Step 0.3: 构建项目

```bash
cd "$OCTOPUS_DIR"
pnpm install --frozen-lockfile 2>&1
pnpm build 2>&1
BUILD_EXIT=$?
```

**构建失败处理**: 分析错误 → 修复 → 重新构建（最多 2 轮）。仍失败 → 报错退出。

**门控**: `BUILD_EXIT == 0` 才能进入 Phase 1。

---

## Phase 1: 启动 Isolated Server

### Step 1.1: 启动 Server

```bash
cd "$OCTOPUS_DIR"

# Workspace 模式: worktree 自动触发 isolated
# 源码模式: 必须加 --isolated 强制隔离
if [ -d "projects" ]; then
  pnpm dev > /tmp/octopus-e2e.log 2>&1 &
else
  pnpm dev --isolated > /tmp/octopus-e2e.log 2>&1 &
fi
DEV_PID=$!
echo "Server PID: $DEV_PID"
```

### Step 1.2: 从日志捕获实际端口

```bash
sleep 10

# 从日志中提取实际端口（⛔ 不猜测！）
SERVER_PORT=$(grep -oP 'server[=: ]+\K[0-9]+' /tmp/octopus-e2e.log | head -1)
WEB_PORT=$(grep -oP 'web[=: ]+\K[0-9]+' /tmp/octopus-e2e.log | head -1)

# 兜底: 从进程获取
if [ -z "$SERVER_PORT" ]; then
  SERVER_PORT=$(lsof -i -P -n 2>/dev/null | grep LISTEN | grep node | awk '{print $9}' | grep -oP ':\K[0-9]+' | head -1)
fi

echo "Server: http://localhost:$SERVER_PORT"
echo "Web:    http://localhost:$WEB_PORT"
```

### Step 1.3: 健康检查（轮询，120s 超时）

```bash
for i in $(seq 1 24); do
  HEALTH=$(curl -sf "http://localhost:$SERVER_PORT/api/health" 2>/dev/null)
  if [ $? -eq 0 ]; then
    echo "✅ Server healthy (attempt $i)"
    break
  fi
  [ -n "$WEB_PORT" ] && curl -sf -o /dev/null "http://localhost:$WEB_PORT/" 2>/dev/null && echo "✅ Web accessible"
  sleep 5
done

[ $i -eq 24 ] && echo "❌ Services failed to start within 120s" && exit 1
```

**门控**: Server 和 Web 都返回 HTTP 200 才能进入 Phase 2。

**输出**: `server_port`, `web_port`, `server_pid`

---

## Phase 2: 创建/选择测试工作空间

### Step 2.1: 检查已有工作空间

```bash
# 查找名称匹配 e2e-test-* 的工作空间
EXISTING=$(curl -s "http://localhost:$SERVER_PORT/api/workspaces" \
  | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const ws=JSON.parse(d);
      const match=ws.find(w=>w.name&&w.name.startsWith('e2e-test-'));
      console.log(match ? match.id : '');
    })
  ")

if [ -n "$EXISTING" ]; then
  # 验证工作空间是否正常
  STATUS=$(curl -sf "http://localhost:$SERVER_PORT/api/workspaces/$EXISTING" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).status||'ok'))")
  if [ "$STATUS" = "ok" ] || [ -z "$STATUS" ]; then
    WORKSPACE_ID="$EXISTING"
    echo "✅ 复用已有工作空间: $WORKSPACE_ID"
    # 跳到 Phase 3
  fi
fi
```

### Step 2.2: 创建新工作空间

```bash
WS_NAME="e2e-test-$(date +%Y%m%d-%H%M%S)"
WORKSPACE_ID=$(curl -s -X POST "http://localhost:$SERVER_PORT/api/workspaces" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$WS_NAME\"}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id||''))")

# 验证
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID")
[ "$HTTP_CODE" = "200" ] && echo "✅ 工作空间已创建: $WORKSPACE_ID" || echo "❌ 创建失败"
```

### Step 2.3: 验证工作空间项目完整性

```bash
WS_PATH=$(curl -s "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).path||''))")

# 检查 projects 目录
ls "$WS_PATH/projects/" 2>/dev/null
# 检查 octopus 项目
ls "$WS_PATH/projects/" | grep -i octopus || echo "⚠️ 未找到 octopus 项目"
# 检查 git 有效性
for dir in "$WS_PATH/projects/"/*/; do
  git -C "$dir" status --short 2>/dev/null | head -3
done
```

**门控**: 工作空间路径有效且包含 octopus 项目才能进入 Phase 3。

**输出**: `workspace_id`, `workspace_path`

---

## Phase 3: 选择测试工程

### Step 3.1: 读取 org 的 manifest.md

```bash
# 确定 org（从配置或目录名推断）
ORG=$(cat ~/.octopus/config.yaml 2>/dev/null | grep default_org | awk '{print $2}' || echo "")
[ -z "$ORG" ] && ORG=$(ls ~/.octopus/ | grep -vE "^(config|db|prod|ports)$" | head -1)

MANIFEST="$HOME/.octopus/$ORG/repos/manifest.md"
echo "读取 manifest: $MANIFEST"
cat "$MANIFEST" 2>/dev/null || echo "❌ manifest 不存在"
```

manifest 格式:
```
## <org>
- octopus git@github.com:XzhiF/octopus.git [main] {cli, tool}
- octopus-demo-service-admin git@github.com:XzhiF/octopus-demo-service-admin.git [main]
- octopus-demo-web-admin git@github.com:XzhiF/octopus-demo-web-admin.git [main]
```

### Step 3.2: 选择测试工程

```bash
# 默认选中 octopus 核心项目
SELECTED_PROJECTS="octopus"

# 如果测试需求涉及 demo 项目，同时选中
# 从 manifest 中提取项目列表
grep "^- " "$MANIFEST" | awk '{print $2}'
```

| 选择策略 | 条件 | 选中项目 |
|---------|------|---------|
| 默认 | 无特殊需求 | `octopus` |
| 全栈测试 | 需求涉及前后端 | `octopus` + `octopus-demo-web-admin` |
| 微服务测试 | 需求涉及 API | `octopus` + 相关 demo 服务 |

### Step 3.3: 拷贝目标工作流到工作空间

```bash
WORKFLOW_SRC="$OCTOPUS_DIR/packages/core-pack/workflows"
WORKFLOW_DEST="$WS_PATH/workflows"
mkdir -p "$WORKFLOW_DEST"

# 拷贝目标工作流
for wf in $TARGET_WORKFLOWS; do
  cp "$WORKFLOW_SRC/$wf.yaml" "$WORKFLOW_DEST/" 2>/dev/null || echo "⚠️ $wf.yaml 不存在"
done

ls "$WORKFLOW_DEST/"
```

### Step 3.4: 准备 execution inputs

```bash
# 读取工作流的 inputs 定义
head -30 "$WORKFLOW_DEST/<workflow>.yaml" | grep -A 20 "inputs:"

# 根据 inputs 定义 + 环境信息生成合理默认值
# 例: {"requirement": "test bug fix", "base_branch": "main"}
```

**输出**: `selected_projects`, `workflow_files`, `input_values`

---

## Phase 4: 测试规划与执行

### Step 4.1: 确定测试类型

| 测试类型 | 判定条件 | 执行方式 |
|---------|---------|---------|
| **Workflow 测试** | 目标是验证 YAML 工作流 | API 创建 execution → 启动 → 监控 |
| **API 测试** | 目标是验证 Server 端点 | curl 调用 → 验证响应 |
| **UI 测试** | 目标是验证 Web App 页面 | agent-browser 操作 → 截图验证 |
| **CLI 测试** | 目标是验证 CLI 命令 | 直接执行 → 验证 exit code + 输出 |
| **集成测试** | 多类型组合 | 串联执行 |

### Step 4.2: 生成测试步骤

对每个测试用例:
```
1. 前置条件 (Setup) — 需要什么环境/数据/状态
2. 操作步骤 (Action) — 按什么顺序执行什么
3. 断言检查 (Assert) — 预期结果是什么
4. 证据要求 (Evidence) — 截图/响应/日志
```

### Step 4.3: 按类型执行

#### Workflow 测试

```bash
# 1. 创建 execution
EXEC_ID=$(curl -s -X POST "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID/executions" \
  -H "Content-Type: application/json" \
  -d "{\"workflow_path\": \"$WORKFLOW_PATH\", \"inputs\": $INPUTS_JSON}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id||''))")

# 2. 启动执行
curl -s -X POST "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID/executions/$EXEC_ID/start"

# 3. 进入 Phase 5 监控
```

#### API 测试

```bash
# GET + 状态码 + 响应体
RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:$SERVER_PORT/api/workspaces")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# 断言
[ "$HTTP_CODE" = "200" ] && echo "✅ 200 OK" || echo "❌ Expected 200, got $HTTP_CODE"

# 解析 JSON
echo "$BODY" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    console.log('count:', r.length ?? r.data?.length ?? 0);
  })
"

# POST 创建
CREATE_RESP=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$SERVER_PORT/api/workspaces" \
  -H "Content-Type: application/json" \
  -d '{"name": "e2e-api-test"}')
CREATE_CODE=$(echo "$CREATE_RESP" | tail -1)
[ "$CREATE_CODE" = "201" ] && echo "✅ Created" || echo "❌ Expected 201, got $CREATE_CODE"

# 安全: SQL 注入
curl -s -w "\n%{http_code}" "http://localhost:$SERVER_PORT/api/workspaces?id=1'+OR+1=1"
# 预期: 400 或空结果
```

#### UI 测试

```bash
agent-browser --session e2e open "http://localhost:$WEB_PORT/<path>"
agent-browser --session e2e wait 2000
agent-browser --session e2e snapshot -i -c
agent-browser --session e2e click @e5
agent-browser --session e2e fill @e8 "test data"
agent-browser --session e2e screenshot /tmp/e2e-step1.png
agent-browser --session e2e errors
agent-browser --session e2e close
```

截图后委派子 Agent（Sonnet 模型）直接分析截图：
```
Agent(model="pro", prompt="读取并分析 /tmp/e2e-step1.png: 页面是否正常渲染？关键元素是否可见？布局是否合理？")
```

#### CLI 测试

```bash
OUTPUT=$(octopus version 2>&1)
EXIT_CODE=$?
[ $EXIT_CODE -eq 0 ] && echo "✅ Exit 0" || echo "❌ Exit $EXIT_CODE"
echo "$OUTPUT" | grep -q "v1.0.0" && echo "✅ Version" || echo "❌ Version mismatch"
```

### Step 4.4: 记录证据

每个用例记录:
```json
{
  "id": "TC-001",
  "result": "pass|fail",
  "assertions": [
    {"check": "...", "result": "pass", "evidence": "HTTP 200, body contains 'ok'"}
  ],
  "screenshots": ["/tmp/e2e-step1.png"],
  "duration_ms": 5000
}
```

---

## Phase 5: 监控等待（Workflow 测试专用）

**⛔ 每个 Bash 命令 ≤ 120 秒**（引擎 300s idle timeout）

```bash
# 轮询 execution 状态（60s 间隔，6h 超时）
for i in $(seq 1 360); do
  sleep 60

  STATUS=$(curl -s "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID/executions/tree" \
    | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const tree=JSON.parse(d);
        const s=tree.map(e=>e.status);
        console.log(s.join(','));
      })
    ")

  echo "[$i] Statuses: $STATUS"

  # 全部到达终态 → 退出
  echo "$STATUS" | grep -qvE "(running|pending)" && break
done
```

**终态判断**:
- 全部 `completed` → 通过
- 有 `failed` → 进入 Phase 6
- 超时（6h）→ 标记失败

---

## Phase 6: 诊断修复循环

### 6.1 根因分析（7 种类型）

委派 **diagnostician** 子代理或直接分析:

| 根因类型 | 判定依据 | 处理方式 |
|---------|---------|---------|
| **YAML_ERROR** | `octopus workflow validate` 报错 | 修 YAML → validate → 重新执行 |
| **CODE_BUG** | 源码逻辑错误 | 修源码 → `pnpm build` → 重测 |
| **AGENT_TIMEOUT** | 节点执行超时 | 调大 timeout → retry |
| **PORT_CONFLICT** | 端口占用 | 杀冲突进程（⛔ 不杀 protected）→ restart |
| **ENVIRONMENT_CORRUPT** | worktree/DB 损坏 | workspace rebuild（有上限） |
| **TEST_FLAKY** | 间歇性失败 | 重跑 3 次取多数 |
| **ASSERTION_ERROR** | 代码正确但断言不合理 | 修正测试预期值 |

### 6.2 修复循环

```
current_fix_round = 0
while (has_failures && current_fix_round < max_fix_rounds):
    current_fix_round++

    for each failed_test:
        root_cause = diagnose(failed_test)
        fix(root_cause)
        rerun(failed_test)

    if all_passed: break
```

### 6.3 Workspace Rebuild（仅 ENVIRONMENT_CORRUPT）

```bash
# 杀旧进程
kill $DEV_PID 2>/dev/null

# 删除旧工作空间
curl -s -X DELETE "http://localhost:$SERVER_PORT/api/workspaces/$WORKSPACE_ID"

# 重新创建
# → 回到 Phase 2 Step 2.2
```

**重建上限**: `max_workspace_rebuilds`（默认 2 次）。达到上限 → 标记不可恢复。

---

## Phase 7: 反假跑验证 + 报告

### 7.1 证据收集（委派 evidence-collector）

```
证据清单:
  - API 调用: HTTP 请求 + 响应码 + 响应体摘要
  - UI 操作: screenshot 路径 + snapshot 文本
  - CLI 命令: exit code + stdout 前 10 行
  - Workflow: execution 状态 + duration + token 使用量
```

**可疑信号**（触发自动失败）:
- execution duration < 5 秒
- agent 节点 0 token 使用
- "全部通过"但无截图/HTTP 响应
- bash 节点无日志输出

### 7.2 现实检验（委派 reality-checker）

```
默认判定: NEEDS WORK
PASSED: 证据完整 + 所有断言 pass
NEEDS WORK: 证据不完整或有断言 fail
FAILED: 发现 fake-run 信号
```

### 7.3 结构化 JSON 报告

```json
{
  "passed": true,
  "environment": {
    "mode": "workspace|source",
    "server_port": 3242,
    "web_port": 3243,
    "workspace_id": "abc-123",
    "selected_projects": ["octopus"]
  },
  "results": [
    {
      "id": "TC-001",
      "type": "workflow|api|ui|cli",
      "result": "pass",
      "assertions": [
        {"check": "execution completed", "result": "pass", "evidence": "status: completed, duration: 45s, tokens: 12345"}
      ],
      "duration_ms": 45000
    }
  ],
  "summary": {
    "total": 10,
    "passed": 10,
    "failed": 0,
    "fix_rounds": 1,
    "rebuild_count": 0
  },
  "anti_fake_run": {
    "verdict": "PASSED",
    "evidence_count": 42,
    "suspicious_signals": []
  },
  "conclusion": "全部测试通过，反假跑验证 PASSED"
}
```

### 7.4 环境处理

```bash
if [ "$all_passed" = "true" ]; then
  # 通过 → 清理
  kill $DEV_PID 2>/dev/null
  agent-browser --session e2e close 2>/dev/null
  echo "✅ 测试通过，环境已清理"
else
  # 失败 → 保留
  echo "=== 测试失败，环境已保留 ==="
  echo "Server: http://localhost:$SERVER_PORT"
  echo "Web:    http://localhost:$WEB_PORT"
  echo "Workspace: $WORKSPACE_ID"
fi
```

---

## 子代理协作（可选）

本 skill 的所有步骤均可由主 agent 独立完成。如果工作流声明了以下子代理，**优先委派**以提高质量和效率：

| 角色 | 委派时机 | 无子代理时 |
|------|---------|-----------|
| 诊断分析 | Phase 6 失败根因分析 | 主 agent 自行分析错误日志 |
| 证据收集 | Phase 7 证据整理 | 主 agent 自行汇总证据 |
| 反假跑验证 | Phase 7 最终判定 | 主 agent 按检查清单自行验证 |
| 截图分析 | Phase 4 UI 测试后 | 主 agent 用 Read 读取 PNG 分析 |
| API 测试 | Phase 4 API 密集测试 | 主 agent 用 curl 自行测试 |

**委派原则**: 子代理是**加速器**而非**依赖项**。skill 中每个步骤都包含完整的执行指令，确保无子代理时也能正确执行。

---

## 通知规则

```bash
# Phase 1 完成
octopus notify --ignore-failure \
  --title "🚀 E2E Server 就绪" \
  --body "Server: $SERVER_PORT | Web: $WEB_PORT | 模式: isolated"

# Phase 2 完成
octopus notify --ignore-failure \
  --title "📦 工作空间已创建" \
  --body "ID: $WORKSPACE_ID | 🔗 http://localhost:$WEB_PORT/workspaces/$WORKSPACE_ID"

# Phase 4 进度
octopus notify --ignore-failure \
  --title "🧪 测试执行中" \
  --body "P0: $P0_PASSED/$P0_TOTAL | P1: $P1_PASSED/$P1_TOTAL"

# Phase 6 修复
octopus notify --ignore-failure \
  --title "🔧 修复第 $ROUND 轮" \
  --body "根因: $ROOT_CAUSE | 修复: $FIX_SUMMARY"

# Phase 7 最终结果
octopus notify --ignore-failure \
  --title "✅/❌ E2E 完成" \
  --body "通过: $PASSED/$TOTAL | 验证: $VERDICT | 修复: $FIX_ROUNDS 轮"
```

---

## 强制约束清单

1. ⛔ Server 必须 `--isolated` 模式（源码模式）或 worktree 模式启动
2. ⛔ 端口从日志/进程获取，**不猜测**
3. ⛔ 健康检查必须 HTTP 200 才算成功
4. ⛔ 每个 Bash 命令 **≤ 120 秒**
5. ⛔ 轮询 sleep **≤ 60 秒**
6. ⛔ 不杀 `protected_ports` 进程
7. ⛔ 截图分析必须委派子 Agent（Sonnet 模型）或用 Read 直接读取 PNG
8. ⛔ 每个 Phase 只执行一次（Phase 6 修复循环除外）
9. ⛔ 子代理调用失败 → 缩短 prompt 重试（最多 2 次）
10. ⛔ 每种通知只发一次
