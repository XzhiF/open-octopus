# Skills Library Manifest

> **来源仓库**: https://github.com/Leonxlnx/taste-skill
>
> **许可证**: MIT License

| Name | Install Name | GitHub URL | 简介 |
|------|-------------|------------|------|
| Taste Skill v2 | `design-taste-frontend` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/taste-skill) | 默认主力 Skill，三旋钮调控（VARIANCE/MOTION/DENSITY），内置 GSAP 骨架和反 slop 规则 |
| Taste Skill v1 | `design-taste-frontend-v1` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/taste-skill-v1) | 原始 v1，保留给依赖旧版行为的项目 |
| GPT Taste | `gpt-taste` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/gpt-tasteskill) | GPT/Codex 专用更严格变体，更强动效和反 slop |
| Image to Code | `image-to-code` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/image-to-code-skill) | 图片优先流水线：生成参考图 → 分析 → 实现代码 |
| Redesign | `redesign-existing-projects` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/redesign-skill) | 已有项目 UI 审计 + 修复 |
| High-End Visual | `high-end-visual-design` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/soft-skill) | 精致高级感 UI，柔和对比、留白、弹性动效 |
| Minimalist UI | `minimalist-ui` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/minimalist-skill) | 编辑风极简（Notion/Linear 风格） |
| Brutalist UI | `industrial-brutalist-ui` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/brutalist-skill) | 粗野工业风，瑞士排版、锐利对比 |
| Full Output | `full-output-enforcement` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/output-skill) | 强制完整输出，禁止占位符和截断代码 |
| Stitch Design | `stitch-design-taste` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/stitch-skill) | Google Stitch 兼容，支持 DESIGN.md 导出 |
| Web Comps (图片) | `imagegen-frontend-web` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/imagegen-frontend-web) | 网站设计稿生成（仅图片，不生成代码） |
| Mobile (图片) | `imagegen-frontend-mobile` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/imagegen-frontend-mobile) | 移动端界面和流程生成（仅图片） |
| Brand Kit (图片) | `brandkit` | [Link](https://github.com/Leonxlnx/taste-skill/tree/main/skills/brandkit) | 品牌视觉识别板生成（仅图片） |

---

> **来源仓库**: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
>
> **许可证**: MIT License

| Name | Install Name | GitHub URL | 简介 |
|------|-------------|------------|------|
| UI UX Pro Max | `ui-ux-pro-max` | [Link](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | AI 设计智能引擎，161 条行业推理规则 + 67 种 UI 风格 + 161 套配色 + 57 组字体，自动生成完整设计系统 |

## 安装

```bash
# Taste Skill 全部安装
npx skills add https://github.com/Leonxlnx/taste-skill

# Taste Skill 安装单个
npx skills add https://github.com/Leonxlnx/taste-skill --skill "<install-name>"

# UI UX Pro Max
npm install -g uipro-cli
uipro init --ai <platform>
```
