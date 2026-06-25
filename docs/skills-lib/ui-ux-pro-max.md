# UI UX Pro Max

> **GitHub**: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
>
> **官网**: https://uupm.cc
>
> **作者**: nextlevelbuilder
>
> **许可证**: MIT License
>
> **版本**: v2.0

---

## 是什么

UI UX Pro Max 是一个 **AI 设计智能引擎**，为 AI 编码助手提供专业的 UI/UX 设计决策能力。它不是一个简单的风格指南，而是一个基于推理引擎的设计系统生成器——根据你的产品类型自动生成完整的、量身定制的设计系统。

## 核心特性

### 1. 设计系统生成器（旗舰功能）

根据项目需求，自动推理并生成完整设计系统，包括：

```
输入: "Build a landing page for my beauty spa"
       ↓
输出:
  ├── 页面模式（Hero-Centric + Social Proof）
  ├── UI 风格（Soft UI Evolution）
  ├── 配色方案（Primary / Secondary / CTA / Background / Text）
  ├── 字体搭配（Cormorant Garamond / Montserrat）
  ├── 关键动效（Soft shadows + Smooth transitions）
  ├── 反模式警告（应避免的设计陷阱）
  └── 交付前检查清单
```

### 2. 161 条行业推理规则

覆盖以下行业的专属设计规则：

| 行业类别 | 示例 |
|---------|------|
| **Tech & SaaS** | SaaS、B2B 服务、开发工具、AI 平台、网络安全 |
| **金融** | Fintech/Crypto、银行、保险、个人财务、发票 |
| **医疗** | 诊所、药房、牙科、兽医、心理健康 |
| **电商** | 通用电商、奢侈品、市场平台、订阅盒、外卖 |
| **服务** | 美容/Spa、餐厅、酒店、法律、家政服务 |
| **创意** | 作品集、Agency、摄影、游戏、音乐流媒体 |
| **生活方式** | 习惯追踪、食谱、冥想、天气、日记 |
| **新兴技术** | Web3/NFT、空间计算、量子计算、无人机 |

每条规则包含：推荐模式、风格优先级、配色情绪、字体情绪、关键动效、反模式。

### 3. 67 种 UI 风格

| 分类 | 风格示例 |
|------|---------|
| **通用风格 (49)** | 极简、Neumorphism、Glassmorphism、Brutalism、3D 超写实、暗色模式、Claymorphism、Aurora UI、复古未来主义、AI-Native UI、Cyberpunk、Spatial UI (VisionOS)、E-Ink、Gen Z Chaos、Biomimetic 等 |
| **落地页风格 (8)** | Hero-Centric、转化优化、功能展示、极简直接、社交证明、交互演示、信任权威、故事驱动 |
| **BI/仪表板风格 (10)** | 数据密集型、热力图、高管仪表板、实时监控、下钻分析、对比分析、预测分析、用户行为、财务、销售智能 |

### 4. 其他设计资源

| 资源 | 数量 | 说明 |
|------|------|------|
| 配色方案 | 161 套 | 与 161 个产品类型 1:1 对齐 |
| 字体搭配 | 57 组 | 含 Google Fonts 导入链接 |
| 图表类型 | 25 种 | 仪表板和分析场景推荐 |
| UX 准则 | 99 条 | 最佳实践、反模式、无障碍规则 |
| 技术栈支持 | 15 个 | React、Next.js、Astro、Vue、Nuxt.js、Svelte、SwiftUI、React Native、Flutter、shadcn/ui、Angular、Laravel 等 |

## 安装

### CLI 安装（推荐）

```bash
npm install -g uipro-cli
cd /path/to/your/project
uipro init --ai <platform>
```

支持的平台：
`claude` `cursor` `windsurf` `antigravity` `copilot` `kiro` `codex` `qoder` `roocode` `gemini` `trae` `opencode` `continue` `codebuddy` `droid` `kilocode` `warp` `augment`

### 全局安装

```bash
uipro init --ai claude --global   # 安装到 ~/.claude/skills/
uipro init --ai cursor --global   # 安装到 ~/.cursor/skills/
```

### 其他命令

```bash
uipro versions              # 查看可用版本
uipro update                # 更新到最新版
uipro init --offline        # 离线安装（使用内置资源）
uipro uninstall             # 卸载
```

## 使用方式

### Skill 模式（自动激活）

支持的平台上，请求 UI/UX 任务时自动激活：

```
Build a landing page for my SaaS product
Create a dashboard for healthcare analytics
Design a portfolio website with dark mode
```

### Workflow 模式（斜杠命令）

Kiro、GitHub Copilot、Roo Code、KiloCode 使用：

```
/ui-ux-pro-max Build a landing page for my SaaS product
```

### 设计系统命令（高级）

```bash
# 生成设计系统（ASCII 输出）
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "beauty spa" --design-system -p "Serenity Spa"

# 生成设计系统（Markdown 输出）
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "fintech banking" --design-system -f markdown

# 领域特定搜索
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "glassmorphism" --domain style
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "elegant serif" --domain typography
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "dashboard" --domain chart

# 技术栈特定指南
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "form validation" --stack react
```

### 设计系统持久化（Master + Overrides 模式）

```bash
# 生成并持久化到 design-system/MASTER.md
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "SaaS dashboard" --design-system --persist -p "MyApp"

# 创建页面级覆盖文件
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "SaaS dashboard" --design-system --persist -p "MyApp" --page "dashboard"
```

生成目录结构：

```
design-system/
├── MASTER.md           # 全局设计系统（颜色、字体、间距、组件）
└── pages/
    └── dashboard.md    # 页面级覆盖（仅偏离 Master 的部分）
```

## 工作流程

```
1. 用户请求 UI/UX 任务
       ↓
2. 多领域并行搜索（产品类型 → 风格 → 配色 → 模式 → 字体）
       ↓
3. 推理引擎处理（BM25 排序 + JSON 条件规则 + 反模式过滤）
       ↓
4. 输出完整设计系统（模式 + 风格 + 配色 + 字体 + 动效 + 反模式 + 检查清单）
       ↓
5. AI 基于设计系统生成代码
       ↓
6. 交付前检查（对比度、响应式、无障碍、反模式验证）
```

## 与 Taste Skill 的对比

| 维度 | UI UX Pro Max | Taste Skill |
|------|--------------|-------------|
| **核心方法** | 推理引擎 + 数据库驱动 | 规则注入 + 旋钮调控 |
| **行业覆盖** | 161 个行业专属规则 | 通用设计语言推断 |
| **风格数量** | 67 种预定义风格 | 3 种风格方向 + 自定义 |
| **配色方案** | 161 套行业配色 | 运行时生成 |
| **字体搭配** | 57 组预置搭配 | 运行时推荐 |
| **技术栈** | 15 个栈的专属指南 | 框架无关 |
| **安装方式** | 专用 CLI (`uipro`) | `npx skills add` |
| **持久化** | Master + Overrides 模式 | 无内置持久化 |
| **定位** | 数据驱动的设计决策引擎 | 反模板化的设计品味注入 |

## 前置依赖

需要 Python 3.x 运行搜索脚本：

```bash
# Windows
winget install Python.Python.3.12

# macOS
brew install python3

# Ubuntu/Debian
sudo apt update && sudo apt install python3
```

## 链接

- GitHub: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- 官网: https://uupm.cc
- npm CLI: https://www.npmjs.com/package/uipro-cli
- 作者其他项目: [NextLevelBuilder.io](https://nextlevelbuilder.io) | [ClaudeKit.cc](https://claudekit.cc)
