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
