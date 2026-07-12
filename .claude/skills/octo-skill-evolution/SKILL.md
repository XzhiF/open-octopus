---
name: octo-skill-evolution
description: "Org-aware Skill 创建经验进化器。四模式: record(4步) / record-fast(3步) / remove(确认→删除→重建) / rebuild(扫描→聚合索引)。让 Skill 创建越用越聪明。"
category: coding-assistant
tags: [skill, evolution, experience, learning, pattern]
version: 5.0.1
priority: medium
---

# Octo Skill Evolution

记录创建经验，下次创建同类 Skill 时自动参考。让创建器越用越聪明。

四模式 (根据参数识别):

| 模式 | 触发 | 说明 |
|------|------|------|
| **record** (默认) | `/octo-skill-evolution {name}` | 4步: 回顾→总结→确认→存储 |
| **record-fast** | `/octo-skill-evolution record-fast {name}` | 3步: 回顾→总结→直接存储 (无确认，从 creator 触发时用) |
| **remove** | `/octo-skill-evolution remove {name}` | 删除某条经验 |
| **rebuild** | `/octo-skill-evolution rebuild` | 重建经验索引 |

record-fast 用于 octo-skill-creator Step 5 用户选"记录"时触发。用户已确认记录意图，跳过确认步骤直接存储。独立事后回顾用 record (4步)。

存储位置: `~/.octopus/{org}/evolution/` (org 级，跨项目共享)
偏好: 全局 `~/.octopus/user_preference.md` + org 级 `~/.octopus/{org}/evolution/{org}_user_preference.md`

**前缀规则**: 目标 Skill 用 org 配置的前缀 (如 my-)，核心 Skill 保持 octo- 前缀。经验文件名使用 {prefix}{name} 格式。

---

## record 模式: 4步流程

前置: 目标 Skill 必须存在于 `.claude/skills/{name}/SKILL.md`

### Step 1: 回顾

纯 AI 分析 (不调用 sub-agent):

读取 `.claude/skills/{name}/SKILL.md` + 辅助文件 (如有 scripts/ references/), 提取:
1. **类别** — frontmatter category
2. **需求关键词** — 从核心功能/工作流程推断 3-5 个关键词
3. **创建模式** — 一句话概括 (如 "部署+审批+验证" / "查询+格式化输出")
4. **关键决策** — 工作流程模式、MCP 调用、环境引用、辅助文件、production safety 设置
5. **frontmatter 质量** — name/description/category/tags 是否合规

不做: 不自动跳到总结，展示回顾结果后等待用户确认继续。

### Step 2: 总结

AI 生成经验提炼, 展示给用户确认:

```
📋 经验总结: octo-{name}

类别: {category}
需求关键词: {3-5个}
创建模式: {一句话概括}

关键决策记录:
  - 工作流程: {3-5步模式描述}
  - MCP: {使用了哪些 MCP 服务} / 无
  - 环境引用: {引用了哪些环境} / 无
  - 辅助文件: {scripts/references 内容} / 无
  - Production safety: {approval_required 设置} / 无

经验提炼 (≤5条):
  - {category} 类 + {关键词} → 常见需要 {什么}
  - {某个决策} → 因为 {原因}
  - {某个模式} → 建议同类需求参考

确认此经验总结？有修改直接说，说"确认存储"写入经验库。
```

长度限制: 每条 experience ≤50 行 (frontmatter ~10行 + body ~40行)

| 区域 | 行数限制 | 规则 |
|------|---------|------|
| frontmatter | ~10 行 (固定) | keywords ≤5, mcp_used/env_used 列表式 |
| 需求关键词 | 1 行 | ≤5 个 |
| 创建模式 | 1 行 | 一句话 |
| 关键决策 | ≤8 行 | ≤5 项 |
| 经验提炼 | ≤8 行 | ≤5 条 |

### Step 3: 确认 (迭代)

本步是**迭代过程**。用户修改意见 → 更新总结 → 重新展示 → 直到说"确认存储"才进 Step 4。

**核心规则**: 任何非"确认存储"的话都是修改意见，不是确认。绝不能把修改意见解读为确认。

### Step 4: 存储

写入两处:

#### 经验文件

`~/.octopus/{org}/evolution/experiences/{prefix}{name}.md`

同名 Skill → 覆盖旧文件 (一个 Skill 只保留最新经验):

```markdown
---
skill_name: octo-{name}
category: {category}
created_at: {date}
pattern: {一句话创建模式}
keywords: [{3-5个}]
mcp_used: [{MCP服务列表}] / []
env_used: [{环境列表}] / []
has_scripts: true/false
has_references: true/false
archived: false
---

## 需求关键词
{关键词列表}

## 创建模式
{一句话}

## 关键决策
- 工作流程: {模式描述}
- MCP: {使用详情} / 无
- 环境引用: {引用详情} / 无
- 辅助文件: {文件列表} / 无
- Production safety: {设置}

## 经验提炼
- {提炼1}
- {提炼2}
- {提炼3}
```

#### 累积索引

`~/.octopus/{org}/evolution/index.md` — 从所有 experience 文件**重新聚合生成** (保证一致性)

index.md 结构 ≤100 行:

```markdown
# Skill Evolution Index

自动生成，由 octo-skill-evolution 维护。供 octo-skill-creator Step 1 自动搜索。

## 经验统计
总创建经验: {n} 条
类别分布: devops {n} | coding-assistant {n} | ...

## 经验条目 (最近50条)

| # | Skill | Category | Pattern | Keywords | MCP | Env | 辅助文件 | Date |
|---|-------|----------|---------|----------|-----|-----|---------|------|
| 1 | octo-xxx | devops | 部署+审批 | 部署,审批 | prod | uat01 | scripts | 2026-04-29 |

## 历史统计 (50条以上部分，如有)

| Category | Pattern | Count | Last Date |
|----------|---------|-------|-----------|
| devops | 部署+审批 | 5 | 2026-03 |
```

**压缩逻辑**: 详细条目上限 50 条。超过时最旧条目压缩为统计行 (每 category+pattern 一行), 经验文件本身永不删除。

存储后展示:
```
✅ 经验已存储: octo-{name}
文件: ~/.octopus/{org}/evolution/experiences/{prefix}{name}.md
索引: ~/.octopus/{org}/evolution/index.md (已更新)
下次创建同类 Skill 时将自动参考此经验。
```

---

## record-fast 模式: 3步流程

从 octo-skill-creator Step 5 用户选"记录"时触发。用户已确认记录意图，跳过确认步骤直接存储。

前置: 目标 Skill 必须存在于 `.claude/skills/{name}/SKILL.md`

### Step 1: 回顾

同 record 模式 Step 1。

### Step 2: 总结

同 record 模式 Step 2，展示经验提炼内容。但末尾提示改为:

```
正在存储此经验到经验库...
```

### Step 3: 直接存储

展示后直接写入 (不做确认) — 同 record 模式 Step 4 的写入逻辑:
- 经验文件 → `~/.octopus/{org}/evolution/experiences/{prefix}{name}.md`
- 累积索引 → `~/.octopus/{org}/evolution/index.md` (重新聚合)

存储后展示:
```
✅ 经验已存储: octo-{name}
文件: ~/.octopus/{org}/evolution/experiences/{prefix}{name}.md
索引: ~/.octopus/{org}/evolution/index.md (已更新)
下次创建同类 Skill 时将自动参考此经验。
```

---

## remove 模式

1. **确认** — "将删除 octo-{name} 的创建经验，确认？" 用户说"确认删除"才继续
2. **执行** — 删除 `~/.octopus/{org}/evolution/experiences/{prefix}{name}.md`
3. **rebuild** — 从剩余 experience 文件重新生成 index.md (含压缩逻辑)
4. **报告** — "已删除 octo-{name} 经验，index.md 已更新 ({n} 条剩余)"

文件不存在 → 提示 "octo-{name} 无经验记录" 并结束。

---

## rebuild 模式

1. **扫描** — 列出 `~/.octopus/{org}/evolution/experiences/` 下所有 .md 文件
2. **检测 archived** — 对每个 experience, 检查 `.claude/skills/{name}/` 是否存在:
    - 不存在 → frontmatter 加 `archived: true`
    - `archived: true` → 不入 index.md 详细条目, 但计入统计摘要
3. **生成 index.md** — 统计摘要 + 详细条目(≤50) + 压缩统计(如有)
4. **聚合 global_experience.md** — 从所有 experience 文件统计提取:
    - **常见犯错提醒**: 读取所有 `## 经验提炼` section，统计每个犯错模式出现次数，≥3次 → 写入
    - **高频创建模式**: 读取所有 frontmatter (category, pattern)，按category聚合创建次数+最常见pattern → 写入
    - 结果写入 `~/.octopus/{org}/evolution/global_experience.md`
    - 长度限制: ≤30 行 (保持精简)
    - **不合并到 user_preference.md** — 三文件独立维护互不干扰: 全局 user_preference.md (全局偏好, creator 加载) + org 级 {org}_user_preference.md (org 偏好, creator 加载) + global_experience.md (rebuild 聚合, 用户自行参考)
5. **报告** — "index.md 已重建: {n} 条有效, {m} 条 archived, {total} 条总计; global_experience.md 已聚合: {n} 条常见犯错提醒, {m} 个高频模式"

experiences/ 目录不存在 → 提示 "经验库为空, 请先 /octo-skill-evolution {name} 记录经验" 并结束。

### global_experience.md 结构

```markdown
# 全局经验总结

由 octo-skill-evolution rebuild 自动聚合生成，不合并到 user_preference.md。
用户可自行参考此文件，也可手动微调。creator 不加载此文件。

## 常见犯错提醒
- {犯错模式1}
- {犯错模式2}

## 高频创建模式
- {category} 类创建 {count} 次，常见模式: {top_pattern}
```

---

## 经验搜索 (供 octo-skill-creator Step 1 使用)

creator Step 1 自动读取 index.md 搜索匹配经验 (不委托 sub-agent):

**搜索流程**:
1. 读取 `~/.octopus/{org}/evolution/index.md`
2. 不存在 → 不提示 (不做推断替代)
3. 存在 → 用推断类别+关键词匹配

**匹配规则** (三级权重):

| 权重 | 条件 |
|------|------|
| 最高 | category 完全匹配 |
| 中 | keywords ≥2 个重叠 |
| 低 | pattern 关键词部分匹配 |

**结果上限**: ≤5 条, 按权重排序, 同权重按时间倒序

**提示格式**:

有详细匹配:
```
💡 经验参考: 过去 {n} 次 {category} 类创建 — 常见模式:
  - {pattern1} (octo-{name1}, {date1})
  - {pattern2} (octo-{name2}, {date2})
```

只有压缩统计:
```
💡 经验参考: 历史统计 — {category} 类创建 {count} 次，常见模式: {top_pattern}
```

无匹配 → 不提示

---

## MCP 注册表

MCP 注册表位于 ~/.octopus/{org}/mcp/，glob *.yaml 获取可用环境文件。
文件名格式: mcp_{env}.yaml，{env} 为环境名 (如 prod, uat01, local)。
默认使用 mcp_prod.yaml (如存在)。

调用: octopus-mcp-cli {server} {tool} '{params}' --env {env} --org {org}