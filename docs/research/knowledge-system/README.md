# Octopus 知识系统 — 设计文档

> **定位**: Agent 的"规则手册"——从执行中学习规则，注入下次执行，形成 Loop
> **状态**: 设计阶段
> **依赖**: [execution-memory-loop.md](../execution-memory-loop.md)（归档基础设施）

---

## 核心问题

Agent 每次执行都是冷启动。上次跑出来的 blocker、踩过的坑、用户反复强调的约束，下次执行时 Agent 完全不知道。

## 核心方案

**执行 → 提取规则 → 人工审核 → 写入知识文件 → 注入下次执行 → 更好的结果 → Loop**

## Agent 认知三层

| 层 | 回答什么 | 类比 | 存储 | 产生方式 |
|----|---------|------|------|---------|
| **记忆 Memory** | 发生了什么 | 日记 | `~/.octopus/agent/memory/` | 自动（每次对话） |
| **知识 Knowledge** | 应该怎么做 | 规则手册 | `~/.octopus/{org}/knowledge/` | 提取 + 人审核 |
| **SKILL** | 怎么完成复杂任务 | 操作手册 | `~/.octopus/{org}/skills/` | 策划 + 人审核 |

**关系**：记忆是原始素材 → 知识是从记忆中提炼的规则 → SKILL 是规则组合成的完整流程

## 文档结构

| 文件 | 内容 |
|------|------|
| [01-knowledge-architecture.md](./01-knowledge-architecture.md) | 知识系统架构：文件结构、格式设计、存储层级 |
| [02-rule-extraction.md](./02-rule-extraction.md) | 规则提取：触发条件、LLM prompt、提取策略 |
| [03-knowledge-injection.md](./03-knowledge-injection.md) | 知识注入：三级注入策略、token 控制、引擎集成 |
| [04-skill-evolution.md](./04-skill-evolution.md) | Skill 化：三个路径、审批流程、与现有 SKILL 系统整合 |
| [05-review-queue.md](./05-review-queue.md) | 审核队列：统一入口、自动/手动策略、冲突检测 |
| [06-agent-integration.md](./06-agent-integration.md) | Agent 全局闭环：与记忆/SKILL/分身/任务的贯通 |
| [07-ui-ux-design.md](./07-ui-ux-design.md) | UI/UX 设计：Dashboard 知识 Tab、归档弹窗、AI 助手 |
| [08-data-flow.md](./08-data-flow.md) | 完整数据流：从执行到注入的闭环、效果追踪、知识衰减 |

## 数据流总览

```
┌── 输入渠道 ──────────────────────────────────────────────────┐
│                                                               │
│  Chat ──┐                                                     │
│  Telegram┤──→ Octopus Agent ──→ 工作流执行 ──→ 执行完成       │
│  Scheduler┤     (统一大脑)          │              │           │
│  Dashboard┘                         │              │           │
│                                     │              ▼           │
│                              知识注入 ←──── extractRules()     │
│                              (下次执行)         │              │
│                                                ▼              │
│                                         审核队列              │
│                                         (Dashboard)           │
│                                                │              │
│                                    ┌───────────┼──────────┐   │
│                                    ▼           ▼          ▼   │
│                              知识文件      SKILL 库    拒绝    │
│                              (规则累积)   (流程模板)           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## 与 execution-memory-loop.md 的关系

`execution-memory-loop.md` 提供归档基础设施（execution_archive 表、ArchiveService、workspace 删除拦截）。

本文档在此基础上增加：
- **知识文件**（Markdown，文件系统）— 替代原方案的 experience_index 表
- **规则提取**（LLM 从执行结果提取 imperative 规则）
- **审核队列**（人-in-the-loop 审核）
- **知识注入**（引擎读 Markdown 注入 prompt）
- **Skill 化**（执行模式 → 可复用 Skill）
