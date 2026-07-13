---
name: octo-guide
description: Octopus 平台指南 — 概念介绍与 CLI 命令参考，当用户提及 Octopus 相关操作或需要了解平台能力时加载
category: knowledge
tags: [cli, guide, repos, init, setup, upgrade, octopus, concepts, mcp, env]
version: 5.0.1
priority: medium
---

# Octo Guide

Octopus 平台概念介绍与 CLI 命令参考。当用户自然语言提及 Octopus 相关操作（如"帮我 pull 项目"、"初始化配置"、"查看版本"）时，Agent 加载此 Skill 理解平台能力并执行正确的 CLI 命令。

## 概念

1. **org 组织隔离** — 每个 org 有独立目录结构（env/mcp/repos/evolution/config），所有操作基于 org。CLI 命令通过 `--org` 参数指定，不指定时从 `~/.octopus/config.yaml` 读 `default_org`

2. **核心范式** — 5步创建流程（需求推断→按需查询→迭代确认→生成→询问验证）、4项按需查询（相似Skill/可用MCP/项目知识/环境信息）、经验进化（双层次偏好：全局 `~/.octopus/evolution/user_preference.md` + org 级 `~/.octopus/{org}/evolution/{org}_user_preference.md`）

3. **Skill 体系** — 核心 Skill 用 `octo-` 前缀（octo-skill-creator/octo-skill-evolution/octo-guide），目标 Skill 用 org 配置的前缀（如 `my-`）。所有 Skill 以 SKILL.md 为主文件，按需生成 scripts/ 和 references/ 辅助文件

4. **Agent 体系** — 5个核心 Agent：
   - mcp-discoverer — 从 YAML 注册表查找 MCP 服务信息
   - skill-searcher — 搜索已有 Skill，检测重复
   - skill-evaluator — 验证 Skill（6点验证）
   - repo-knowledge — 搜索 repowiki 知识，提取业务领域知识
   - env-discoverer — 搜索 org 级环境信息

5. **YAML 注册表 + CLI 直连 MCP** — MCP 服务信息存储在 `~/.octopus/{org}/mcp/*.yaml`（glob 动态发现），Skill 通过 `octopus-mcp-cli` 直连 backend Server 调用，不经过 Router 代理

6. **env 集中管理** — 环境信息存放在 `~/.octopus/{org}/env/*.md`（6个环境 md 文件），Skill 引用路径而非内嵌值

7. **repos 管理** — `~/.octopus/{org}/repos/manifest.md`（项目清单含 git URL）+ `~/.octopus/{org}/repos/index.md`（索引）+ `~/.octopus/{org}/repos/projects/`（克隆目录）

8. **验证体系** — 6点验证替代旧9点：YAML frontmatter / 结构完整性 / 生产安全 / 内容覆盖 / 自包含完整性 / MCP 参考 validity

## CLI 命令参考

### 1. 基础命令

| 命令 | 签名 | 用途 | 自然语言映射 |
|------|------|------|-------------|
| init | `octopus init [dir] --org <org> [--force]` | 初始化工作空间：安装 Skills + Agents + org 配置 | "初始化项目"、"设置 octopus" |
| setup | `octopus setup [--org] [--dry-run] [--force]` | 初始化/更新 ~/.octopus/{org}/ 目录 | "更新 org 配置"、"运行 setup" |
| upgrade | `octopus upgrade` | 升级（版本不同时触发 setup） | "升级 octopus"、"更新版本" |
| version | `octopus version` | 显示版本号 | "查看版本"、"octopus 什么版本" |

### 2. repos 命令

| 命令 | 签名 | 用途 | 自然语言映射 |
|------|------|------|-------------|
| repos update | `octopus repos update [--org] [--scan-dirs] [--clone-missing] [--ai-desc]` | 更新项目索引 + 可选克隆 | "更新 repos"、"扫描项目"、"同步项目列表" |
| repos pull | `octopus repos pull [PROJECTS...] [--org] [--branch]` | 拉取指定或全部项目更新 | "帮我 pull 项目"、"拉取 git 项目"、"更新代码" |
| repos clone | `octopus repos clone PROJECT [--org] [--branch]` | 克隆指定项目 | "clone xyz 项目"、"下载项目" |
| repos rebuild-index | `octopus repos rebuild-index [--org] [--ai-desc] [--scan-dirs]` | 重建 index.md | "重建索引"、"刷新项目索引" |

### 3. MCP/环境相关

- 查 MCP 注册表 → 读取 `~/.octopus/{org}/mcp/*.yaml`（glob 动态发现所有 mcp_{env}.yaml）
- 调用 MCP → `octopus-mcp-cli {server} {tool} '{params}' --env {env} --org {org}`
- 查环境信息 → 读取 `~/.octopus/{org}/env/*.md`

## org 参数规则

- 所有命令支持 `--org` 参数，不指定时从 `~/.octopus/config.yaml` 读 `default_org`
- 项目级 octopus 配置也记录 org 值
- Agent 执行 CLI 命令时应自动读取 org 值，不要求用户每次手动指定
- 读取方式：`cat ~/.octopus/config.yaml` 获取 `default_org`，或从项目配置获取项目级 org

## 路径参考

| 路径 | 内容 |
|------|------|
| `~/.octopus/config.yaml` | 全局配置（default_org） |
| `~/.octopus/{org}/config.yaml` | org 级配置（name, prefix, groups, clone_base） |
| `~/.octopus/{org}/env/*.md` | 环境信息文件 |
| `~/.octopus/{org}/mcp/*.yaml` | MCP 注册表（mcp_prod.yaml 等，glob *.yaml 动态发现） |
| `~/.octopus/{org}/repos/manifest.md` | 项目清单（含 git URL） |
| `~/.octopus/{org}/repos/index.md` | 项目索引 |
| `~/.octopus/{org}/repos/projects/` | 克隆的项目目录 |
| `~/.octopus/{org}/evolution/index.md` | 经验索引 |
| `~/.octopus/{org}/evolution/experiences/` | 经验文件目录 |
| `.claude/skills/` | 已安装的 Skills |
| `.claude/agents/` | 已安装的 Agents |