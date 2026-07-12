---
name: octo-skill-creator
description: "Org-aware Skill 创建器。5步流程：需求推断与草案 → 按需查询(sub-agent) → 实现方案总结 → 生成 → 询问验证(skill-evaluator)。目标 Skill 以 SKILL.md 为主文件，按需生成辅助文件。"
category: coding-assistant
tags: [skill, creator, agent, MCP, eval-driven, repowiki, sub-agent]
version: 5.0.1
priority: high
---

# Octo Skill Creator

5步创建企业级 Skill。目标 Skill 以 SKILL.md 为主文件，按需可生成 scripts/ 和 references/ 等辅助文件。简单 Skill 只需 SKILL.md。

确认模型: 自然对话，每步以确认提示结尾。用户明确确认后才继续。不自判"用户似乎完成了"。

## Step 1: 需求推断与草案

纯 AI 推理 (不调用 sub-agent):

1. **名称推导** — 核心名词 → kebab-case → 加当前 org 前缀 (如 my-); 核心 Skill 保持 octo- 前缀
2. **描述推导** — 一句话描述 (≤1024 chars, 写入 frontmatter description)
3. **功能拆解** — 2-5 个核心功能点
4. **工作流程推导** — 3-5 步执行顺序 (每步一句话)
5. **类别推荐** — 映射到 6 值之一 (troubleshooting/knowledge/coding-assistant/devops/business/other)
6. **需求清晰度** — 清晰→展示草案，不清晰→对话补充
7. **智能提示** — 推断出时加 💡 提示行，未推断出不提示:
   - MCP: `💡 可能需要 MCP ({类型})，可说"查可用 MCP"`
   - 项目知识: `💡 可能需要项目知识 ({领域})，可说"查项目知识"/"查项目"/"查接口"`
   - 环境信息: `💡 可能需要环境信息 ({中间件/域名})，可说"查环境信息"`
   - 相似 Skill: `💡 可能有相似 Skill，可说"查相似 Skill"`
8. **经验搜索** — 读取 ~/.octopus/{org}/evolution/index.md (org 从工作空间或 default_org 确定):
    - 不存在 → 不提示 (不做推断替代)
    - 存在 → 用推断类别+关键词匹配 (category权重>keywords≥2重叠>pattern部分匹配)
    - 结果 ≤5 条 → 💡 经验参考提示行 (详细条目优先，压缩统计补充)
    - 无匹配 → 不提示
9. **用户偏好** — 双层次读取:
     - 全局偏好: ~/.octopus/user_preference.md — 不存在不影响
     - org 偏好: ~/.octopus/{org}/evolution/{org}_user_preference.md — 不存在不影响
     - 合并策略: 全局偏好作为基线，org 偏好覆盖特定项
     - 用户偏好 → 影响默认选项倾向 (如默认验证环境、输出语言、常用MCP)

草案展示模板:
```
📋 Skill 草案: {prefix}{name}

类别: {category}
描述: {org_name} - {description}
核心功能: {2-5点}
工作流程: {3-5步}

{智能提示行 (如有)}
{💡 经验参考行 (如有)}
需求清晰度: 清晰/需补充

确认以上内容？有修改直接说，确认后说"开始查询"或"开始生成"。
```

不做: 不自动跑 sub-agent，不在草案中显示 tags。

## Step 2: 按需查询 (用户触发)

用户触发后，通过 Task 委托对应 Agent (.md 定义自带完整指令):

| 查询 | 触发词 | Agent | 关键参数 |
|------|--------|-------|---------|
| 🔍 查相似 Skill | "查相似 Skill"/"有没有类似的"/"帮我搜一下" | skill-searcher | 需求+关键词 |
| 🔌 查可用 MCP | "查可用 MCP"/"需要什么 MCP"/"帮我查 MCP" | mcp-discoverer | 需求+技术关键词 |
| 📚 查项目知识 | "查项目知识"/"查项目"/"查接口"/"查 repo wiki"/"相关代码库" | repo-knowledge | 需求+业务关键词 |
| 🌍 查环境信息 | "查环境信息"/"查环境配置"/"查域名"/"查中间件"/"查连接信息" | env-discoverer | 需求+中间件关键词+环境偏好 |

Agent 执行规范:
- YAML 注册表不存在/搜索失败 → 如实告知，不做推断替代 (mcp-discoverer/env-discoverer)
- index.md/repowiki/env 不存在 → 如实告知缺失状态，让用户决定下一步

**重要**: 智能提示只是建议，不是确认。 只有用户主动触发关键字查询并得到结果后，才在方案中写入对应内容。对于MCP严格禁止用户未声明下进行agent查询以及调用； 没查 MCP → 方案不写 MCP；没查项目知识 → 方案不写知识参考。

引用优先规则 (仅用户实际查到的资源):
- 相似 Skill ≥90% → 强烈建议复用
- 相似 Skill ≥70% → 参考结构改编
- MCP → 写入 `## MCP 参考` section + octopus-mcp-cli 调用命令
- 项目知识 → 写入 `## 知识参考` section
- 环境信息 → 写入 `## 环境参考` section，引用路径而非内嵌值

## Step 3: 迭代方案确认

本步是**迭代过程**，不是一次性确认。每次用户给修改意见 → 更新方案 → 重新展示 → 直到用户说"确认生成"才进 Step 4。

**核心规则**: 用户说的任何非"确认生成"/"开始生成"的话，都是修改意见，不是确认。绝不能把修改意见解读为确认然后跳到生成。

### 方案格式 = 草案格式 + 引用补充

继续使用 Step 1 的草案格式，增加用户实际查到的引用信息:

```
📋 Skill 方案: {prefix}{name}

类别: {category}
描述: {org_name} - {description}
核心功能: {2-5点} (含修改)
工作流程: {3-5步} (含修改)
辅助文件: {如需 scripts/references，列出具体文件名和用途} (如不需要则不写此行)

引用补充 (仅用户实际查到的):
  {无 → 此区域不出现}
  项目知识: {查到的知识摘要} → {写入 ## 知识参考}
  环境信息: {查到的环境} → {写入 ## 环境参考}
  辅助文件: {scripts/references} → {写入 SKILL.md 引用}

💡 补充建议 (未确认，可说"加上 xxx" 调整方案):
  {无 → 此区域不出现}
  经验: {经验搜索匹配的模式建议}
  项目知识: {推断但未查的知识领域，可说"查项目知识"}
  环境信息: {推断但未查的环境，可说"查环境信息"}
  辅助文件: {推断可能需要的 scripts/references}

有修改直接说。说"确认生成"开始写入文件。
```

**绝对不写的内容**: 用户没查到的资源 (如没查 MCP 却写 MCP 调用方案)。未查 = 方案中不存在。

**补充建议规则**: 补充建议 ≠ 方案内容。用户没说"加上"，最终方案不包含。无补充建议 → 此区域不出现。

## Step 4: 生成

按确认的方案写入 `.claude/skills/{name}/` 目录:

### 目录结构与辅助文件规则

```
.claude/skills/{prefix}xxx/
├── SKILL.md          # 主文件 (必需)
├── [scripts/]        # 方案确认含 scripts → 必须创建脚本文件
└── [references/]     # 方案确认含 references → 必须创建参考文件
```

**辅助文件生成规则**: 方案中写了 `辅助文件: scripts/xxx.py → {用途}` → 必须实际创建该脚本文件，SKILL.md 内引用 `./scripts/xxx.py`。方案中写了 references → 同理。不能只写 SKILL.md 提到脚本但不创建文件。

### Category 最小 Sections

| troubleshooting | Overview, Investigation Steps, Solutions |
| knowledge | Overview, Data Sources, Query Patterns |
| coding-assistant | Overview, Constraints, Output Format |
| devops | Overview, Prerequisites, Execution Plan |
| business | Overview, Process Steps, Exception Handling |
| other | Overview, Main Content |

### MCP 调用 (仅用户实际查到 MCP 时)

调用方式: `octopus-mcp-cli {server名} {tool名} '{params}' --env {env}`

必附 `## MCP 参考` section:
```markdown
## MCP 参考

注册表: ~/.octopus/{org}/mcp/ (glob *.yaml 获取可用环境)
默认环境: prod (mcp_prod.yaml)
覆盖环境:
  - prod (生产) — {查到的 tool 名}

调用: octopus-mcp-cli {server} {tool} '{params}' --env {env} --org {org}
```

### 知识引用 (仅用户实际查到项目知识时)

```markdown
## 知识参考
- {project} ({group}/{name}) — {引用了什么}

源码定位: ~/.octopus/{org}/repos/index.md
不可达 → octopus repos clone {group}/{name} --org {org}
```

### 环境引用 (仅用户实际查到环境信息时)

```markdown
## 环境参考
引用: ~/.octopus/{org}/env/
覆盖环境:
  - {env-name} ({env-label}) — {引用的 section 名}

不可达 → octopus setup --org {org} 重新生成
```

格式: `引用:` 写目录路径；`覆盖环境:` 每行 `- {env-name} ({env-label}) — {sections}`；支持 "全部" 列全部 env。

### YAML Frontmatter

```yaml
name: {name}        # org 前缀 (如 my-)，核心 Skill 用 octo-
description: {desc} # ≤1024 chars
category: {cat}     # 6值
tags: [{tags}]      # 1-10
```

## Step 5: 询问验证

生成后询问用户选择验证模式:

| 选项 | 模式 | 委托 Agent | 说明 |
|------|------|-----------|------|
| 1 | full | skill-evaluator | 6点预检+场景设计+执行验证+修复+报告 |
| 2 | precheck_only | skill-evaluator | 只做6点静态检查 |
| 3 | 跳过 | 无 | 不验证，直接交付 |

委托 skill-evaluator 时传递: `{验证模式, Skill 路径}` — Agent .md 自带完整流程定义 (5 Phase / 6点 / 场景风险分级 / 3轮修复循环)。

跳过验证时展示:
```
✅ {name} 已生成，未验证
文件: .claude/skills/{name}/SKILL.md
```

验证完成后展示 + 询问记录经验:
```
✅ {name} — 验证完成 | 模式: {mode} | 状态: {pass/pass_with_warnings/fail} | 修复: {n}项

是否记录此创建经验？记录后下次创建同类 Skill 可自动参考。
  1. 记录 — 触发 /octo-skill-evolution record-fast {name}
  2. 跳过 — 不记录
```

用户选"记录" → 触发 octo-skill-evolution record-fast 模式 (3步: 回顾→总结→直接存储，无需再确认)
用户选"跳过" → 结束

## MCP 注册表

MCP 注册表位于 ~/.octopus/{org}/mcp/，glob *.yaml 获取可用环境文件。
文件名格式: mcp_{env}.yaml，{env} 为环境名 (如 prod, uat01, local)。
默认使用 mcp_prod.yaml (如存在)。

调用: octopus-mcp-cli {server} {tool} '{params}' --env {env} --org {org}