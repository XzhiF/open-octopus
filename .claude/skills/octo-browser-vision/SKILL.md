---
name: octo-browser-vision
description: "浏览器操控与视觉分析基础能力。agent-browser CLI 全套命令（snapshot/click/fill/evaluate/console）、截图视觉分析（原生视觉优先 + 脚本兜底）、Accessibility Tree 策略。被 octo-browser-debug 和 octo-e2e-assurance 引用，也可独立使用。"
category: devops
tags: [browser, vision, agent-browser, screenshot, accessibility-tree, hermes]
---

# 浏览器与视觉分析能力

> 本 skill 是**基础工具层**，包含浏览器操控和视觉分析的全部命令参考。
> 不含测试方法论或调试方法论——那些由 octo-e2e-assurance 和 octo-browser-debug 提供。
>
> **使用方式**：
> - 被其他 skill 引用（agent 看到"前置依赖"指令后自动加载）
> - 独立使用（只需操作浏览器或分析截图时直接加载）

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

### 分析策略（优先级从高到低）

```
1. Accessibility Tree (snapshot)       — 文本化页面结构，零视觉开销（首选）
2. 模型原生视觉 (Read 工具读 PNG)       — 模型自身支持视觉时直接使用（推荐）
3. vision_analyze.py / hermes chat     — 仅当模型不支持视觉时的兜底
```

**原则：能用 snapshot 解决的不用截图；能用模型原生视觉的不用脚本兜底。**

### 判断当前模型是否支持视觉

- **支持视觉的模型**：Sonnet 4.x、Opus 4.x 及后续版本 — 直接用 `Read` 工具读取 PNG 文件即可分析
- **不支持视觉的模型**：Haiku 3.x、纯文本模型 — 使用 `vision_analyze.py` 脚本或 `hermes chat` 兜底
- **不确定时**：尝试 `Read` 工具读一张截图，如果能返回图片内容描述则支持视觉

### 方式 1：Accessibility Tree（首选）

**snapshot 返回文本化的 Accessibility Tree，不需要任何视觉能力：**

```bash
# 获取可交互元素（压缩模式）
SNAP=$(agent-browser --session demo snapshot -i -c)
echo "$SNAP"
# [e1] button "创建工作空间"
# [e2] input "搜索..."
# [e3] link "工作空间A"

# 直接从文本中验证
if echo "$SNAP" | grep -q "创建工作空间"; then
  echo "✅ 找到创建按钮"
fi
```

**只在以下情况需要截图 + 视觉分析：**
- snapshot 无法获取足够信息（如 Canvas 渲染、图片内容）
- 需要验证视觉布局（如"页面是否正常渲染，不是白屏"）
- 需要识别错误截图中的具体错误信息
- 需要验证样式/颜色等视觉属性

### 方式 2：模型原生视觉（推荐，当模型支持时）

**当模型支持视觉时，直接用 `Read` 工具读取截图文件即可分析，无需任何外部工具：**

```bash
# 1. 截图
agent-browser --session demo screenshot /tmp/step1.png
```

然后直接用 Read 工具读取截图：
```
Read(file_path="/tmp/step1.png")
```

模型看到图片后，可以直接回答：
- 页面是否正常渲染？
- 布局是否正确？
- 有没有错误信息？
- 特定元素是否可见？

**示例验证流程：**
```bash
# 1. 截图
agent-browser --session demo screenshot /tmp/step1.png
```
```
# 2. Read 工具读取截图，直接分析内容
Read("/tmp/step1.png")
# → 模型直接看图回答："页面显示工作空间列表，有 2 个工作空间，'创建工作空间'按钮在右上角"
```

### 方式 3：脚本兜底（仅当模型不支持视觉时）

**当模型不支持视觉理解时，使用以下工具作为兜底：**

#### vision_analyze.py

```bash
# 基本用法 — 详细描述页面内容
python <skill-dir>/scripts/vision_analyze.py /tmp/screenshot.png

# 带具体问题
python <skill-dir>/scripts/vision_analyze.py /tmp/screenshot.png "页面是否正常加载？有没有错误信息？"

# 验证特定元素
python <skill-dir>/scripts/vision_analyze.py /tmp/screenshot.png "页面上是否有'待审批'文字？按钮文本是什么？"

# JSON 格式输出
python <skill-dir>/scripts/vision_analyze.py /tmp/screenshot.png "列出所有可见按钮" --json
```

#### hermes chat

```bash
# 分析截图
hermes chat -q "请分析图片 /tmp/screenshot.png，告诉我页面上有什么内容和错误"

# 验证特定内容
hermes chat -q "看图片 /tmp/screenshot.png，页面上是否有'创建成功'的文字？"

# 检查布局
hermes chat -q "分析 /tmp/screenshot.png，页面布局是否正常？有没有白屏或错位？"
```

### 视觉验证流程

```bash
# 1. 截图
agent-browser --session demo screenshot /tmp/step1.png

# 2. 分析（根据模型能力选择方式）
#    模型支持视觉 → Read("/tmp/step1.png") 直接分析
#    模型不支持视觉 → python <skill-dir>/scripts/vision_analyze.py /tmp/step1.png "页面是否显示工作空间列表？"

# 3. 基于分析结果判断
#    直接根据视觉分析结果做出测试判定
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
4. **snapshot 优先** — 能用 Accessibility Tree 验证的不用截图，省掉视觉模型调用
5. **证据完整** — 每个验证都要有具体证据（文本匹配、截图路径、JS 执行结果）
