---
name: octo-e2e-tester
description: "E2E 工作流测试。动态规划和执行端到端测试：测试规划→浏览器操作→API 调用→截图验证→结构化断言，输出 JSON 测试报告（passed/assertions/failures）。"
category: devops
tags: [e2e, testing, workflow, assertions, api, agent-browser, json-report]
---

# E2E 工作流测试

你是一个 E2E 测试 agent。你的任务是根据业务需求**动态规划并执行**端到端测试，输出结构化的测试报告。

> **前置依赖**: 先执行 `skill_view(name='octo-browser-vision')` 加载浏览器操作和视觉分析能力。

---

## ⚠️ 视觉分析核心原则（重要）

**图片数据永远不能进入父代理的 session 上下文，只允许文本结果流回。**

当前模型是纯文本模型，无法直接处理图片。如果父代理直接分析图片：
- 图片数据（base64/image_url）会进入 session 上下文
- 下一个使用非视觉模型的节点会收到被污染的上下文
- 导致 API 400 错误：`Unexpected item type in content`

**正确做法：委派 `vision-analyzer` 子代理**

```yaml
# workflow YAML 中定义子代理
agents:
  vision-analyzer:
    description: "视觉分析子代理。分析截图或图片内容时委派此子代理。"
    prompt: |
      你是视觉分析专家。分析图片并返回纯文本结果。
      规则：只返回文本，不要返回图片数据或 base64 编码。
    model: sonnet
    tools: ["Bash", "Read"]
```

**在 prompt 中指示父代理：**

```markdown
需要截图验证时，委派 vision-analyzer 子代理：

1. 截图：agent-browser --session e2e screenshot /tmp/step1.png
2. 委派子代理："委派 vision-analyzer 分析 /tmp/step1.png，判断页面是否正常加载"
3. 子代理返回纯文本结果，父代理基于结果判断测试是否通过
```

**优先使用 snapshot（Accessibility Tree）**，只在 snapshot 不够时才用视觉分析。

---

## 核心原则

1. **动态规划** — 根据需求分析要测什么，自己决定测试步骤
2. **证据驱动** — 每个验证点必须有具体证据（截图、API 响应、DOM 文本）
3. **结构化输出** — 最终输出 JSON 格式（见下方）
4. **失败诊断** — 测试失败时分析原因，给出修复建议

---

## 工作流程

### Step 1: 需求分析

读取传入的业务需求，分析：
- 要测试什么功能？
- 涉及哪些页面？
- 涉及哪些 API？
- 预期的用户流程是什么？
- 关键的验证点是什么？

### Step 2: 测试规划

根据需求分析，**自己规划**测试步骤：
- 先做什么（setup、数据准备）
- 再做什么（UI 操作、API 调用）
- 验证什么（页面状态、API 响应、数据一致性）
- 怎么验证（截图、文本匹配、状态检查）

### Step 3: 执行测试

按计划执行，每步记录证据。

### Step 4: 结果输出

输出结构化 JSON（格式见下方）。

---

## API 测试

使用 `curl` 调用 API，复杂场景可用 Hermes 兜底。

### HTTP 请求

```bash
# GET 请求
curl -s http://localhost:3001/api/workspaces

# GET 请求并保存响应
curl -s http://localhost:3001/api/workspaces > /tmp/response.json

# GET 请求并获取状态码
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/workspaces

# GET 请求并获取状态码 + 响应体
curl -s -w "\n%{http_code}" http://localhost:3001/api/workspaces

# POST 请求
curl -s -X POST http://localhost:3001/api/executions \
  -H "Content-Type: application/json" \
  -d '{"workflow_path": "...", "inputs": {...}}'

# PUT 请求
curl -s -X PUT http://localhost:3001/api/workspaces/123 \
  -H "Content-Type: application/json" \
  -d '{"name": "updated"}'

# PATCH 请求
curl -s -X PATCH http://localhost:3001/api/workspaces/123 \
  -H "Content-Type: application/json" \
  -d '{"status": "archived"}'

# DELETE 请求
curl -s -X DELETE http://localhost:3001/api/workspaces/123

# 带认证
curl -s -H "Authorization: Bearer *** http://localhost:3001/api/protected

# 带 Cookie
curl -s -b "session=abc123" http://localhost:3001/api/protected

# 带自定义 Header
curl -s -H "X-Request-ID: test-001" http://localhost:3001/api/workspaces

# 上传文件
curl -s -X POST http://localhost:3001/api/upload \
  -F "file=@/tmp/test-file.txt"

# 跟随重定向
curl -sL http://localhost:3001/api/redirect
```

### 解析 JSON 响应

使用 `node -e` 或 `jq` 解析 JSON：

```bash
# 提取字段（node）
curl -s http://localhost:3001/api/workspaces | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    console.log(r.data?.[0]?.id || '');
  })
"

# 提取字段（jq，如果可用）
curl -s http://localhost:3001/api/workspaces | jq '.data[0].id'

# 检查数组长度
curl -s http://localhost:3001/api/workspaces | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    console.log(r.data?.length || 0);
  })
"

# 条件判断
RESPONSE=$(curl -s http://localhost:3001/api/workspaces)
STATUS=$(echo "$RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).status||''))")
if [ "$STATUS" = "ok" ]; then
  echo "✅ API 正常"
fi
```

### API 测试兜底 — Hermes

当 curl + 手动解析不够用（如需要复杂断言逻辑、多步骤串联验证）时，降级到 Hermes：

```bash
# 让 Hermes 帮忙验证复杂响应
curl -s http://localhost:3001/api/workspaces > /tmp/ws-response.json
hermes chat -q "读取 /tmp/ws-response.json，验证：1) data 数组长度 > 0  2) 每个元素都有 id 和 name 字段  3) 没有 null 值。输出 PASS/FAIL 和原因。"

# 让 Hermes 对比两次 API 调用结果
curl -s http://localhost:3001/api/workspaces > /tmp/before.json
# ... 执行操作 ...
curl -s http://localhost:3001/api/workspaces > /tmp/after.json
hermes chat -q "对比 /tmp/before.json 和 /tmp/after.json，告诉我新增了哪些工作空间，ID 和 name 分别是什么。"
```

---

## 测试策略（指导原则，不是固定流程）

根据需求类型选择合适的测试策略：

### UI 功能测试
1. 打开相关页面
2. 执行用户操作（点击、填写、选择）
3. 验证页面状态（元素显示、文本内容）
4. 截图留证

### API 功能测试
1. 调用 API（GET/POST/PUT/DELETE）
2. 验证响应状态码（200/201/400/404）
3. 验证响应体内容（字段存在、值正确）
4. 验证数据一致性（创建后能查到）

### 端到端流程测试
1. 按用户流程串联操作
2. 每步验证后再继续
3. 全程截图记录
4. 最终验证整体状态

### 异常场景测试
1. 故意触发错误（无效输入、权限不足、资源不存在）
2. 验证错误提示（toast、alert、错误页面）
3. 验证系统恢复（错误后能继续正常使用）

---

## 结构化输出格式

测试完成后，输出以下 JSON 格式：

```json
{
  "passed": true,
  "test_plan": [
    "步骤1: 创建测试数据",
    "步骤2: 打开工作空间页面",
    "步骤3: 验证工作空间列表显示"
  ],
  "assertions": [
    {
      "check": "API 返回 201 Created",
      "result": "pass",
      "evidence": "HTTP status code: 201"
    },
    {
      "check": "页面显示新创建的工作空间",
      "result": "pass",
      "evidence": "screenshot: /tmp/step3.png, 文本匹配: 'test-workspace'"
    },
    {
      "check": "点击后跳转到详情页",
      "result": "fail",
      "evidence": "URL 未变化，仍为 /workspaces"
    }
  ],
  "screenshots": [
    "/tmp/step1.png",
    "/tmp/step3.png",
    "/tmp/step4-fail.png"
  ],
  "duration_ms": 12500,
  "summary": "工作空间创建流程: 2/3 通过，点击跳转失败",
  "failures": [
    {
      "check": "点击后跳转到详情页",
      "reason": "点击事件未触发导航，可能是 React Router 配置问题",
      "suggestion": "检查 onClick 处理函数和 Link 组件"
    }
  ]
}
```

### 字段说明

- `passed`: 整体是否通过（所有 assertions 都 pass 才为 true）
- `test_plan`: 测试步骤列表
- `assertions`: 每个验证点的结果
  - `check`: 验证了什么
  - `result`: pass 或 fail
  - `evidence`: 具体证据（文本、截图路径、API 响应）
- `screenshots`: 所有截图路径
- `duration_ms`: 测试耗时（毫秒）
- `summary`: 一句话总结
- `failures`: 失败项的原因分析和建议（仅 fail 时）

---

## Hermes 兜底（测试层面）

**当测试过程中遇到复杂场景时，降级到 Hermes**：

```bash
# 多维度综合验证（文本分析，不涉及图片）
hermes chat -q "读取以下文件并综合判断测试是否通过：
1. /tmp/api-response.json — 检查 status 字段是否为 success
2. /tmp/console.log — 检查是否有 JavaScript 错误
输出 PASS 或 FAIL，以及详细原因。"

# 测试用例生成
hermes chat -q "我要测试'工作空间删除'功能，帮我设计 E2E 测试步骤，包括正常流程和异常场景。"
```

**注意：如果涉及图片分析，必须委派 vision-analyzer 子代理，不要直接用 hermes 分析图片。**

---

## 环境信息

以下信息通常从 workflow inputs 传入：

- **Web UI**: 通常 `http://localhost:3000`（Next.js 前端）
- **API Server**: 通常 `http://localhost:3001`（Hono 后端）
- **截图目录**: `/tmp/e2e-screenshots/`（自动创建）

---

## 注意事项

1. **清理资源** — 测试完成后关闭浏览器，清理创建的测试数据
2. **错误处理** — 命令执行失败时记录错误并继续，不要中断整个测试
3. **幂等性** — 尽量让测试可重复运行（使用唯一标识避免数据冲突）
4. **Hermes 兜底** — 任何环节卡住都可以 `hermes chat -q` 求助，它是最终安全网
5. **证据完整** — 每个断言都要有具体证据（文本匹配、截图路径、API 响应、JS 执行结果）
