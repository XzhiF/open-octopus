---
name: octo-agent-orchestrator
description: Agent intent classification and workflow selection engine
category: coding-assistant
tags: [orchestration, workflow, intent, classification]
---

# Octopus Agent Orchestrator

## Purpose
Classify user intent and select the appropriate workflow chain for execution.

## Trigger Conditions
- User sends any natural language message to the Agent
- Message requires intent classification before action

## Intent Classification Rules

### Decision Tree
1. **single_task** — One-shot development task
   - Keywords: 加/改/修/创建/实现/写/fix/add/implement/create
   - Examples: "加黑色主题", "修复登录bug", "create API endpoint"
   - Action: Match workflow → execute → report

2. **scheduled_task** — Recurring/repeated task
   - Keywords: 每天/每周/定时/定期/every/daily/weekly/cron
   - Examples: "每天10点总结PR", "每周一报告", "daily summary"
   - Action: Create schedule job → configure memory → set notifications

3. **info_query** — Information lookup from memory/history
   - Keywords: 昨天/之前/做过/查/what/when/搜索/find/search
   - Examples: "昨天做了什么", "查找黑色主题决策"
   - Action: Search memory → format response

4. **clone_management** — Clone lifecycle operations
   - Keywords: 分身/clone/创建分身/委派/合并/delegate/merge
   - Examples: "创建前端分身", "把任务交给分身"
   - Action: Clone CRUD → delegate → report

5. **knowledge_curation** — 投喂泛化：把外部知识编进 wiki（知识策展）
   - Keywords: 编进/入库/收录/沉淀/投喂 (+ wiki 语境)
   - Examples: "把这篇编进 wiki https://example.com/a", "沉淀这篇：<长文本>", "这个文件收录进 wiki C:\docs\note.md"
   - Hit features: 投喂动词 **且** 伴随 URL / 长文本 / 本地文件路径——两者缺一不路由
   - 误吞防护（classifyKcFeed 先例纪律）：无投喂动词不路由（讨论/提问/wiki 内容查询=正常对话）；
     动词在但无可投对象不吞（"上次入库的那篇讲了啥？"⇒ 走 info_query）
   - Action: Call `ingest_to_wiki` tool { mode: "url"|"text"|"file", url?/text?/path?, title? }
     → 回执即确认：raw 冻结 + 编译入全局串行队列；抓取卡/diff 卡自动回流本会话（Lane A），
       编译落定后终态卡追加——你只需简述回执，**不要**复述原始 JSON 或自拼后续命令

## Workflow Selection Strategy
1. Search Skill Search for matching workflows
2. Score each candidate by keyword + context match
3. Select top match (score > 0.6) or suggest dynamic generation
4. Organize inputs from user message + Repo Knowledge

## Inputs Organization Template
```yaml
workflow: <matched_workflow_name>
inputs:
  requirement: <user's core requirement>
  target_scope: <affected packages/files>
  workspace: <target workspace name>
```
