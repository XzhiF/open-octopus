---
name: octo-browser-debug
description: "界面探索式调试。根据用户描述复现 UI 问题，探索式操作浏览器定位原因，输出自然语言诊断结果（问题描述+证据+可能原因+修复建议）。高频开发场景：样式确认、报错复现、布局检查。"
category: troubleshooting
tags: [debug, browser, ui, screenshot, explore, diagnose, agent-browser]
---

# 界面探索式调试

你是一个界面调试 agent。用户会描述一个 UI 问题（"按钮点了没反应"、"样式不对"、"提交报错"），你的任务是**复现问题、定位原因、给出修复建议**。

> **前置依赖**: 先执行 `skill_view(name='octo-browser-vision')` 加载浏览器操作和视觉分析能力。

---

## 核心原则

1. **复现优先** — 先复现问题，再分析原因。不要假设原因
2. **探索式操作** — 不是按固定流程，是根据每步观察结果动态决定下一步
3. **多源证据** — 截图 + 控制台日志 + 网络请求 + DOM 状态，交叉验证
4. **修复建议** — 不只说"有问题"，要说"可能原因"和"怎么修"

---

## 工作流程

### Step 1: 理解问题

从用户描述中提取关键信息：

- **哪个页面？** — 推断 URL（如"工作空间页面" → `http://localhost:3000/workspaces`）
- **哪个元素？** — 按钮/输入框/列表/表单
- **什么操作？** — 点击/填写/提交/滚动
- **什么现象？** — 没反应/报错/样式异常/数据不对

如果信息不够，向用户确认。如果足够，直接开始。

### Step 2: 打开页面 + 初始观察

```bash
# 打开目标页面
agent-browser --session debug open <url>

# 获取页面结构
agent-browser --session debug snapshot -i -c

# 截图确认初始状态
agent-browser --session debug screenshot /tmp/debug-initial.png

# 检查控制台是否有已有错误
agent-browser --session debug errors
```

**观察要点**：
- 页面是否正常加载？（不是白屏、不是 404）
- 目标元素是否存在？（snapshot 中能找到）
- 控制台是否有预先存在的错误？（记录为基线）

### Step 3: 复现操作

按用户描述执行操作，**每步操作后都记录状态**：

```bash
# 执行操作
agent-browser --session debug click @eN          # 或 fill / select / press

# 等待响应
agent-browser --session debug wait 1000

# 操作后快照
agent-browser --session debug snapshot -i -c

# 操作后截图
agent-browser --session debug screenshot /tmp/debug-after-action.png

# 检查新增的控制台错误
agent-browser --session debug errors

# 检查网络请求
agent-browser --session debug network
```

**关键对比**：操作前 vs 操作后
- URL 是否变化？
- DOM 是否更新？（新元素出现/旧元素消失）
- 控制台是否新增错误？
- 网络请求是否发出？成功还是失败？

### Step 4: 深入诊断

根据 Step 3 的观察，**动态决定**下一步检查什么：

```bash
# 检查 DOM 状态
agent-browser --session debug evaluate "document.querySelector('.target')?.textContent"
agent-browser --session debug evaluate "document.querySelector('.target')?.className"
agent-browser --session debug evaluate "document.querySelector('.target')?.disabled"

# 检查样式
agent-browser --session debug evaluate "getComputedStyle(document.querySelector('.target')).display"
agent-browser --session debug evaluate "getComputedStyle(document.querySelector('.target')).visibility"

# 检查事件绑定
agent-browser --session debug evaluate "typeof document.querySelector('.target')?.onclick"

# 检查应用状态（Next.js）
agent-browser --session debug evaluate "JSON.stringify(window.__NEXT_DATA__?.props?.pageProps)"

# 检查存储
agent-browser --session debug evaluate "localStorage.getItem('token')"
agent-browser --session debug evaluate "sessionStorage.getItem('user')"
agent-browser --session debug evaluate "document.cookie"

# 检查 React 内部状态（如果可用）
agent-browser --session debug evaluate "document.querySelector('[data-reactroot]')?.__reactFiber$"
```

**诊断思路**：
- 点了没反应 → 检查 onclick 绑定、disabled 状态、z-index 遮挡、JS 错误
- 样式不对 → 检查 computedStyle、className、CSS 变量、媒体查询
- 数据没显示 → 检查 API 响应、条件渲染、loading 状态、空数据
- 提交报错 → 检查表单数据、网络请求 payload、响应状态码和 body

### Step 5: 输出诊断结果

用**自然语言**输出（不需要 JSON 格式），包含：

1. **问题描述** — 复现了什么现象
2. **复现步骤** — 具体操作了什么
3. **证据** — 截图路径、控制台错误、网络请求结果
4. **可能原因** — 基于证据推断的原因（可能多个，按可能性排序）
5. **修复建议** — 具体怎么改代码或配置

**输出示例**：

```
## 诊断结果

**问题**: 点击"创建工作空间"按钮后页面无反应

**复现步骤**:
1. 打开 http://localhost:3000/workspaces
2. 页面正常加载，显示工作空间列表
3. 点击"创建工作空间"按钮
4. 无任何变化

**证据**:
- 截图: /tmp/debug-initial.png (操作前), /tmp/debug-after-action.png (操作后)
- 控制台错误: `TypeError: Cannot read property 'open' of undefined`
- 网络请求: 无新请求发出

**可能原因**:
1. 按钮的 onClick 处理函数引用了未定义的变量（控制台报错指向）
2. 组件 props 中缺少 `onCreate` 回调

**修复建议**:
- 检查 WorkspaceList 组件的 onClick 处理函数
- 确认 `onCreate` prop 是否正确传入
- 控制台错误第 3 行指向 `WorkspaceList.tsx:45`，建议从那里开始排查
```

---

## 常见调试场景

### "点了没反应"

```
检查顺序:
1. 控制台是否有 JS 错误 → errors
2. 按钮是否 disabled → evaluate "...disabled"
3. onclick 是否绑定 → evaluate "typeof ...onclick"
4. 是否有元素遮挡 → evaluate "document.elementFromPoint(x, y)"
5. 网络请求是否发出 → network
```

### "样式不对"

```
检查顺序:
1. 截图对比预期 → screenshot + 视觉分析
2. computedStyle → evaluate "getComputedStyle(...).property"
3. className 是否正确 → evaluate "...className"
4. CSS 变量值 → evaluate "getComputedStyle(document.documentElement).getPropertyValue('--var')"
5. 响应式断点 → evaluate "window.innerWidth"
```

### "提交后报错"

```
检查顺序:
1. 表单数据是否正确 → evaluate "new FormData(form)"
2. 网络请求发出 → network
3. 请求 payload → 从 network 中查看
4. 响应状态码 → 从 network 中查看
5. 响应 body 错误信息 → evaluate 或 snapshot 查看页面错误提示
6. 控制台错误 → errors
```

### "数据没显示"

```
检查顺序:
1. API 是否调用 → network
2. API 响应是否有数据 → 从 network 或 curl 验证
3. 数据是否正确渲染 → snapshot 查看 DOM
4. 条件渲染逻辑 → evaluate 检查状态变量
5. loading/error 状态 → evaluate 或 snapshot
```

### "页面白屏"

```
检查顺序:
1. 控制台是否有致命错误 → errors
2. JS bundle 是否加载 → evaluate "document.querySelectorAll('script').length"
3. React 是否挂载 → evaluate "document.querySelector('#__next')?.innerHTML"
4. API 是否阻塞渲染 → network 查看挂起的请求
5. 截图确认 → screenshot + 视觉分析
```

---

## Hermes 兜底（调试层面）

当自己分析不了时，让 Hermes 帮忙：

```bash
# 分析控制台错误
ERRORS=$(agent-browser --session debug errors)
hermes chat -q "以下是浏览器控制台错误，帮我分析最可能的原因和影响范围：
$ERRORS"

# 分析截图
hermes chat -q "看 /tmp/debug-after-action.png，页面上有什么异常？有没有错误提示、空白区域、或错位的元素？"

# 对比前后截图
hermes chat -q "对比 /tmp/debug-initial.png 和 /tmp/debug-after-action.png，点击按钮后页面有什么变化？如果没有变化说明什么？"

# 分析网络请求
NETWORK=$(agent-browser --session debug network)
hermes chat -q "以下是网络请求记录，哪些请求失败了？失败的请求和页面问题有什么关联？
$NETWORK"
```

---

## 注意事项

1. **不要假设原因** — 用证据说话，每步操作后都要观察
2. **每次操作后都 snapshot 或截图** — 避免错过状态变化
3. **控制台错误要完整记录** — 不要只记最后一条，上下文很重要
4. **先记录基线** — 操作前的控制台错误、网络请求，用于对比操作后的增量
5. **探索是动态的** — 如果 Step 3 发现了 JS 错误，Step 4 就直接分析错误，不需要走完所有检查
6. **关闭浏览器** — 调试完成后 `agent-browser --session debug close`
