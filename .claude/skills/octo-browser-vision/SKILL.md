---
name: octo-browser-vision
description: "浏览器操控与视觉分析基础能力。agent-browser CLI 全套命令（snapshot/click/fill/evaluate/console）、截图视觉分析（通过 vision-analyzer 子代理隔离）、Accessibility Tree 策略。被 octo-browser-debug 和 octo-e2e-tester 引用，也可独立使用。"
category: devops
tags: [browser, vision, agent-browser, screenshot, accessibility-tree, subagent, vision-analyzer]
---

# 浏览器与视觉分析能力

> 本 skill 是**基础工具层**，包含浏览器操控和视觉分析的全部命令参考。
> 不含测试方法论或调试方法论——那些由 octo-e2e-tester 和 octo-browser-debug 提供。
>
> **使用方式**：
> - 被其他 skill 引用（agent 看到"前置依赖"指令后自动加载）
> - 独立使用（只需操作浏览器或分析截图时直接加载）

---

## ⚠️ 视觉分析核心原则（重要）

**图片数据永远不能进入父代理的 session 上下文，只允许文本结果流回。**

当前大多数模型（如 qwen3.7-max）是纯文本模型，无法直接处理图片。如果父代理尝试直接分析图片：
- 图片数据（base64/image_url）会进入 session 上下文
- 下一个使用非视觉模型的节点会收到被污染的上下文
- 导致 API 400 错误：`Unexpected item type in content`

**正确做法：委派 `vision-analyzer` 子代理**

```markdown
# 在 workflow YAML 中定义子代理
agents:
  vision-analyzer:
    description: "视觉分析子代理。分析截图或图片内容时委派此子代理。"
    prompt: |
      你是视觉分析专家。分析图片并返回纯文本结果。
      规则：只返回文本，不要返回图片数据或 base64 编码。
    model: sonnet          # 使用支持视觉的模型
    tools: ["Bash", "Read"]

# 在 prompt 中指示父代理委派
prompt: |
  执行 E2E 测试。需要分析截图时，委派 vision-analyzer 子代理。
```

**执行流程**：
```
父代理 (非视觉模型, 主 session)
  │  上下文里只有纯文本
  │
  ├── 截图到 /tmp/screen.png (文件操作，不进入上下文)
  │
  ├── 委派 vision-analyzer 子代理
  │     │
  │     └── 子代理 (sonnet, 独立 session)
  │           ├── 读取图片
  │           ├── 分析图片（图片在子代理 session 里）
  │           └── 返回文本结果 → 流回父代理
  │
  └── 父代理收到文本结果（上下文仍然干净）✅
```

**错误做法（禁止）**：
```markdown
# ❌ 父代理直接处理图片
prompt: |
  截图并直接分析图片内容...  # 模型可能在上下文中嵌入图片数据
```

---

## 浏览器操作

使用 `agent-browser` CLI 操控浏览器。

### 基本模式

1. 打开页面: `agent-browser --session <name> open <url>`
2. 获取可交互元素: `agent-browser --session <name> snapshot -i -c`（返回带 @ref 的元素列表）
3. 根据 @ref 操作: `click @e2`、`fill @e3 "text"`
4. 操作后再次 `snapshot` 验证结果
5. 关键步骤 `screenshot <path>` 截图留证
6. 完成后 `agent-browser --session <name> close` 关闭

### 页面导航

```bash
agent-browser --session <name> open <url>           # 导航到 URL
agent-browser --session <name> back                 # 后退（浏览器历史）
agent-browser --session <name> forward              # 前进
agent-browser --session <name> reload               # 刷新页面
agent-browser --session <name> get url              # 获取当前 URL
agent-browser --session <name> get title            # 获取页面标题
agent-browser --session <name> close                # 关闭浏览器
```

### 快照（Snapshot）

**snapshot 是浏览器操作的核心**——返回文本化的 Accessibility Tree，纯文本模型可直接理解，无需视觉模型。

```bash
# 获取可交互元素（压缩模式）— 最常用
agent-browser --session <name> snapshot -i -c
# 输出示例:
# [e1] button "创建工作空间"
# [e2] input "搜索工作空间..."
# [e3] link "工作空间A"

# 获取完整页面内容（full=true）— 用于验证文本内容
agent-browser --session <name> snapshot --full
# 输出完整的页面文本，包括非交互元素
```

**策略**：
- 操作前用 `snapshot -i -c` 获取元素 ref
- 操作后用 `snapshot -i -c` 验证状态变化
- 需要检查文本内容时用 `snapshot --full`
- 只在 snapshot 不够用时才用截图 + 视觉分析

### 元素操作（用 snapshot 返回的 @ref 定位）

```bash
agent-browser --session <name> click @eN            # 点击元素
agent-browser --session <name> fill @eN "text"      # 清空并填写输入框
agent-browser --session <name> type @eN "text"      # 逐字输入（不清空）
agent-browser --session <name> select @eN "value"   # 下拉选择
agent-browser --session <name> check @eN            # 勾选复选框
agent-browser --session <name> uncheck @eN          # 取消勾选
agent-browser --session <name> hover @eN            # 悬停（触发 tooltip 等）
```

### 获取元素信息

```bash
agent-browser --session <name> get text @eN         # 获取元素文本
agent-browser --session <name> get value @eN        # 获取输入框当前值
agent-browser --session <name> get html @eN         # 获取元素 HTML
agent-browser --session <name> get count "<selector>" # 获取匹配元素数量
agent-browser --session <name> get attribute @eN "href"  # 获取元素属性
```

### 键盘操作

```bash
agent-browser --session <name> press Enter          # 回车（提交表单）
agent-browser --session <name> press Tab            # Tab（焦点切换）
agent-browser --session <name> press Escape         # Esc（关闭弹窗）
agent-browser --session <name> press "Control+a"    # 全选
agent-browser --session <name> press "Control+c"    # 复制
agent-browser --session <name> press "Control+v"    # 粘贴
agent-browser --session <name> press Backspace      # 退格删除
agent-browser --session <name> press "Shift+Enter"  # 换行（不提交）
```

### 滚动

```bash
agent-browser --session <name> scroll down          # 向下滚动
agent-browser --session <name> scroll up            # 向上滚动
agent-browser --session <name> scroll down 500      # 向下滚动指定像素
```

### 等待策略

```bash
agent-browser --session <name> wait 1000            # 等待指定毫秒
agent-browser --session <name> wait "<selector>"    # 等待元素出现
agent-browser --session <name> wait "@eN"           # 等待特定 ref 元素
```

**等待原则**：
- 页面跳转后等 500-1000ms 让内容渲染
- 动态加载内容用 `wait "<selector>"` 等元素出现
- API 调用后等响应返回再 snapshot

### JavaScript 执行

**在页面上下文中执行 JavaScript**：

```bash
# 执行 JS 表达式并返回结果
agent-browser --session <name> evaluate "document.title"
agent-browser --session <name> evaluate "document.querySelectorAll('button').length"
agent-browser --session <name> evaluate "JSON.stringify(window.__NEXT_DATA__)"
agent-browser --session <name> evaluate "localStorage.getItem('token')"
agent-browser --session <name> evaluate "document.querySelector('.error')?.textContent || 'no error'"

# 检查页面状态
agent-browser --session <name> evaluate "document.readyState"           # 页面加载状态
agent-browser --session <name> evaluate "window.scrollY"                # 滚动位置
agent-browser --session <name> evaluate "document.cookie"               # Cookie 内容

# DOM 操作（慎用，优先用 ref 操作）
agent-browser --session <name> evaluate "document.querySelector('#hidden-btn').click()"
agent-browser --session <name> evaluate "window.scrollTo(0, document.body.scrollHeight)"
```

### 控制台与调试

```bash
agent-browser --session <name> console              # 查看 console.log/warn/error 输出
agent-browser --session <name> console --clear      # 清除控制台缓冲区
agent-browser --session <name> errors               # 查看未捕获的 JS 异常
agent-browser --session <name> network              # 查看网络请求记录
```

### 截图

```bash
agent-browser --session <name> screenshot /tmp/step1.png           # 全页截图
agent-browser --session <name> screenshot /tmp/step2.png @eN       # 元素截图（如果支持）
```

### 示例流程

```bash
# 1. 打开页面
agent-browser --session demo open http://localhost:3000/workspaces

# 2. 获取可交互元素
agent-browser --session demo snapshot -i -c
# [e1] button "创建工作空间"
# [e2] input "搜索工作空间..."
# [e3] link "工作空间A"
# [e4] link "工作空间B"

# 3. 点击按钮
agent-browser --session demo click @e1

# 4. 等待并验证
agent-browser --session demo wait 1000
agent-browser --session demo snapshot -i -c
# 检查新元素（如弹窗/表单）是否出现

# 5. JS 检查状态
agent-browser --session demo evaluate "document.querySelector('.modal')?.style.display"

# 6. 截图留证
agent-browser --session demo screenshot /tmp/after-click.png

# 7. 检查控制台错误
agent-browser --session demo errors

# 8. 关闭
agent-browser --session demo close
```

---

## 视觉分析（截图识别）

当前模型是纯文本模型，无法直接查看图片。**必须委派 `vision-analyzer` 子代理**处理视觉任务，避免图片数据污染父代理的 session 上下文。

### 视觉分析策略

```
1. Accessibility Tree (snapshot)    — 无需视觉，文本直接理解（首选）
2. vision-analyzer 子代理           — 委派子代理分析截图（推荐）
3. vision_analyze.py 脚本           — 子代理内部使用的工具（不直接调用）
4. hermes chat                      — 最终兜底（子代理内部使用）
```

**原则：能用 snapshot 解决的不用截图，需要截图分析时委派子代理。**

### 使用方式：委派 vision-analyzer 子代理

**前提：workflow YAML 中已定义 vision-analyzer 子代理**

```yaml
agents:
  vision-analyzer:
    description: "视觉分析子代理。分析截图或图片内容时委派此子代理。"
    prompt: |
      你是视觉分析专家。分析图片并返回纯文本结果。
      规则：只返回文本，不要返回图片数据或 base64 编码。
    model: sonnet
    tools: ["Bash", "Read"]
```

**在 prompt 中指示父代理委派：**

```markdown
## 视觉分析规则

**禁止父代理直接处理图片** — 必须委派 vision-analyzer 子代理：

1. 截图后，委派子代理分析：
   "委派 vision-analyzer 分析 /tmp/screenshot.png，判断页面是否正常加载"

2. 验证特定元素：
   "委派 vision-analyzer 分析 /tmp/step2.png，确认是否有'创建成功'提示"

3. 对比截图：
   "委派 vision-analyzer 对比 /tmp/before.png 和 /tmp/after.png，描述变化"

子代理会返回纯文本分析结果，父代理基于结果继续执行。
```

### 视觉验证流程示例

```markdown
# 1. 截图
agent-browser --session demo screenshot /tmp/step1.png

# 2. 委派 vision-analyzer 子代理分析
委派 vision-analyzer 分析 /tmp/step1.png：
"页面是否显示工作空间列表？有没有'创建工作空间'按钮？"

# 3. 子代理返回文本结果（示例）
"页面顶部显示'工作空间'标题，列表中有 3 个工作空间卡片，
右上角有紫色'创建工作空间'按钮。"

# 4. 父代理基于结果判断
if 子代理结果包含"创建工作空间":
  echo "✅ 页面显示工作空间相关内容"
```

### Accessibility Tree 优先（无需视觉）

**优先使用 `agent-browser snapshot` 获取文本化页面信息：**

```bash
# snapshot 返回文本格式的 Accessibility Tree，纯文本模型可以直接理解
SNAP=$(agent-browser --session demo snapshot -i -c)
echo "$SNAP"
# 输出示例:
# [e1] button "创建工作空间"
# [e2] input "搜索..."
# [e3] link "工作空间A"
# [e4] text "共 2 个工作空间"

# 直接从文本中验证
if echo "$SNAP" | grep -q "创建工作空间"; then
  echo "✅ 找到创建按钮"
fi
```

**只在以下情况需要视觉分析（委派子代理）：**
- snapshot 无法获取足够信息（如 Canvas 渲染、图片内容）
- 需要验证视觉布局（如"页面是否正常渲染，不是白屏"）
- 需要识别错误截图中的具体错误信息
- 需要验证样式/颜色等视觉属性

### 子代理内部实现（技术细节）

`vision-analyzer` 子代理内部使用以下工具链（父代理无需关心）：

**工具 1：vision_analyze.py 脚本**
```bash
# 子代理内部调用
python <skill-dir>/scripts/vision_analyze.py /tmp/screenshot.png "页面是否正常加载？"
```

脚本内部逻辑：
1. 优先调用 DashScope qwen3.6-plus API（视觉模型）
2. 如果 API 失败，自动降级到 `hermes chat`

**工具 2：直接调 DashScope API**
```bash
# 子代理内部使用
API_KEY="${DASHSCOPE_API_KEY}"
IMG_B64=$(base64 -w0 /tmp/screenshot.png 2>/dev/null || base64 /tmp/screenshot.png 2>/dev/null)
curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"qwen3.6-plus\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/png;base64,$IMG_B64\"}},
        {\"type\": \"text\", \"text\": \"描述这张截图的内容\"}
      ]
    }]
  }"
```

**工具 3：Hermes CLI 兜底**
```bash
# 子代理内部兜底
hermes chat -q "请分析图片 /tmp/screenshot.png，告诉我页面上有什么内容和错误"
```

---

## 环境信息

- **Web UI**: 通常 `http://localhost:3000`（Next.js 前端）
- **API Server**: 通常 `http://localhost:3001`（Hono 后端）
- **截图目录**: `/tmp/e2e-screenshots/`（自动创建）

---

## 注意事项

1. **会话隔离** — 使用 `--session` 参数避免与其他浏览器操作冲突
2. **等待策略** — 页面加载后适当等待，避免元素未渲染就操作
3. **截图留证** — 关键步骤（尤其是失败时）必须截图
4. **snapshot 优先** — 能用 Accessibility Tree 验证的不用截图
5. **视觉分析委派** — 需要截图分析时，必须委派 vision-analyzer 子代理，禁止父代理直接处理图片
6. **证据完整** — 每个验证都要有具体证据（文本匹配、截图路径、子代理分析结果、JS 执行结果）
