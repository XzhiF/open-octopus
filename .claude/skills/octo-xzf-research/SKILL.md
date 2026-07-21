---
name: octo-xzf-research
description: "Codebase 领域研究 + 外部调研 — 三层研究方法论"
category: coding-assistant
tags: [xzf-dev]
version: 1.0.0
---

# Codebase 领域研究方法论

## 触发条件
Stage 1 `idea-research` swarm dispatch 节点，每位专家加载此 skill 进行领域研究。

## 输入

- **Idea 文档**: `.octopus/xzf/{feature}/00-init/idea.md`
- **Workspace 拓扑**: `.octopus/xzf/{feature}/00-init/workspace-topology.md`
- **预扫描结果**: `.octopus/xzf/{feature}/01-research/_scan/`

## 00-init/idea.md 格式

```markdown
# Idea
## 需求描述
{原始需求}

## Research 指引（可选）
### 内部研究重点
{codebase 中需要重点研究的模块/方向}

### 外部调研
{需要调研的外部平台/技术/库，可附 URL}
```

## 三层研究方法论

每位专家的研究文件包含三层:

### 1. Internal (Codebase)
- 现有实现摘要（关键文件、模式、约定）
- 代码结构（入口文件、核心模块）
- 已有能力和限制

### 2. External (Domain Knowledge)
- 相关技术知识和最佳实践
- 外部平台 API 文档（使用 WebFetch 读取）
- 框架特性、库用法

### 3. Key Decisions
- 对后续开发有指导意义的信息
- 技术选型建议
- 风险和注意事项

## Research 指引处理

**如有 Research 指引:**
- **内部研究重点** → 优先定位指引中的模块深入分析
- **外部调研** + URL → 使用 WebFetch 读取文档，提取关键信息
- **外部调研** 无 URL → 使用 WebSearch 搜索相关知识

**如无 Research 指引:**
- 根据 Idea 内容自行判断需要研究什么
- 重点关注 Idea 涉及的现有模块

## 外部调研输出格式

调研外部平台时，提取:
- 认证方式
- 核心接口列表（Method + Path + 用途）
- 回调/webhook 机制
- 频率限制
- 对本次 Idea 的影响

## 研究文件输出格式

写入: `.octopus/xzf/{feature}/01-research/{domain}.md`

```markdown
# {领域}研究

## Internal
{现有代码实现摘要}

## External
{外部知识/平台 API/最佳实践}

## Key Decisions
{决策信息}

## GAPS（如有未覆盖领域）
{标记 + 建议在澄清阶段补充}
```

## 预扫描文件使用

_scan/ 目录文件用于快速定位:
- `file-tree.txt` → 项目文件结构
- `deps.txt` → 依赖和版本
- `claude-mds.txt` → 项目约定
- `api-entries.txt` → API 入口文件
- `db-schemas.txt` → 数据模型文件
- `test-config.txt` → 测试配置

先读预扫描文件定位，再 Read 目标文件深入分析。避免盲读。
