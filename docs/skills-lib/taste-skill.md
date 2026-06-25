# Taste Skill

> **GitHub**: https://github.com/Leonxlnx/taste-skill
>
> **作者**: Leonxlnx
>
> **许可证**: MIT License · Copyright (c) 2026 Leonxlnx

---

## 是什么

Taste Skill 是一个 **Anti-Slop（反模板化）前端设计 Skill 集合**，核心目标：让 AI 生成的 UI 摆脱千篇一律的"模板感"，拥有更强的布局、排版、动效和间距感。

它是一组可移植的 Agent Skill（`SKILL.md` 文件），可以安装到 ChatGPT、Codex、Cursor、Claude Code 等 AI 编码助手中，升级它们生成前端界面的设计质量。

## 解决的问题

AI 编码助手生成的前端代码普遍存在以下问题：
- 布局千篇一律（居中 + 对称 + 三列卡片）
- 配色平庸（默认 Tailwind 蓝色系）
- 动效缺失或粗糙
- 间距和层次感差
- 整体看起来像"样板项目"

Taste Skill 通过注入设计规则和约束，引导 AI 生成更有设计感的输出。

## Skill 分类

### 代码类（生成前端代码）

| Skill | 定位 |
|-------|------|
| **design-taste-frontend** (v2) | 默认主力，三旋钮调控（VARIANCE / MOTION / DENSITY），简报推断 + 设计系统映射 |
| **design-taste-frontend-v1** | 旧版保留，稳定不变 |
| **gpt-taste** | GPT/Codex 专用严格版，更强布局和动效约束 |
| **image-to-code** | 图片流水线：生成参考图 → 分析 → 实现代码 |
| **redesign-existing-projects** | 已有项目 UI 审计和渐进式改进 |
| **full-output-enforcement** | 强制完整输出，禁止占位符和截断 |
| **stitch-design-taste** | Google Stitch 兼容，支持 DESIGN.md 导出 |

### 视觉风格类（叠加使用，指定设计方向）

| Skill | 风格 |
|-------|------|
| **high-end-visual-design** | 精致高级感，柔和对比、大量留白、高级字体、弹性动效 |
| **minimalist-ui** | 编辑风极简（Notion/Linear 风格），克制配色、清晰结构 |
| **industrial-brutalist-ui** | 粗野工业风，瑞士排版、锐利对比、实验性布局 |

### 图片生成类（仅生成设计参考图，不生成代码）

| Skill | 用途 |
|-------|------|
| **imagegen-frontend-web** | 网站设计稿（Hero、落地页、多区块） |
| **imagegen-frontend-mobile** | 移动端界面和流程 |
| **brandkit** | 品牌视觉识别板 |

## 核心特性

### 三旋钮调控（v2）

通过 1-10 的数值精确控制设计方向：

```
DESIGN_VARIANCE:  1 (居中/干净) ──────── 10 (不对称/现代)
MOTION_INTENSITY: 1 (hover 微交互) ───── 10 (滚动/磁性动效)
VISUAL_DENSITY:   1 (宽敞留白) ────────── 10 (密集仪表板)
```

### 反 Slop 规则

内置反重复规则集，防止 AI 生成通用化 UI：
- 禁止常见配色模式（默认 Tailwind 蓝）
- 禁止常见布局模式（三列卡片居中）
- 强制 em-dash 禁令
- GSAP 动画代码骨架规范化

### 框架无关

规则针对设计意图而非特定框架 API，适用于 React、Vue、Svelte 等任何前端框架。

## 安装

```bash
# 安装所有 Skill
npx skills add https://github.com/Leonxlnx/taste-skill

# 安装单个 Skill
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"

# 手动使用：复制 SKILL.md 粘贴到 ChatGPT/Codex 对话中
```

## 选型指南

| 场景 | 推荐 Skill |
|------|-----------|
| 新项目通用设计 | `design-taste-frontend` (v2) |
| 依赖旧版行为 | `design-taste-frontend-v1` |
| GPT/Codex 严格模式 | `gpt-taste` |
| 图片→代码流水线 | `image-to-code` |
| 改进已有项目 | `redesign-existing-projects` |
| AI 输出不完整 | `full-output-enforcement` |
| 已确定视觉方向 | 叠加对应风格 Skill |
| 仅需设计参考图 | 图片生成类 Skill |

## 工作流示例

### 图片优先开发

```
1. 使用 imagegen-frontend-web 生成设计参考图
2. 将参考图传给编码 Agent（Codex / Cursor / Claude Code）
3. 使用 image-to-code 让 Agent 分析并实现代码
```

### 完整设计+开发

```bash
# 安装设计 Skill + 输出完整性 Skill
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"
npx skills add https://github.com/Leonxlnx/taste-skill --skill "full-output-enforcement"
```

## 链接

- GitHub: https://github.com/Leonxlnx/taste-skill
- 官网: https://tasteskill.dev
- 联系: hello@tasteskill.dev
- Twitter: @lexnlin / @blueemi99
