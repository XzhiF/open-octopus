---
name: octo-xzf-implementer
description: "Tracer Bullet 执行方法论 — 单 task 全栈实现 + 轻量验证"
category: coding-assistant
tags: [xzf-dev]
version: 4.0.0
---

# Tracer Bullet 执行方法论

## 触发条件
dynamic_sub_workflow 生成的 DAG 中的 agent 节点，执行单个 tracer bullet task。
task 内容和目标由 DAG 节点的 prompt 传入。

## 核心理念

**实现优先，轻量验证。** 每个 tracer bullet 写完代码后跑单测确认基本正确，
不做深度集成验证和反假跑检查——这些由 Stage 6 E2E 统一覆盖。

## 执行流程

### 准备工作

开始实现前，读取项目领域知识：
```
{project}/CONTEXT.md 或 CONTEXT-MAP.md   ← 领域术语
```
变量、函数、类、模块命名必须使用 CONTEXT.md 中已有的术语。如术语不存在于 CONTEXT.md，按 codebase 现有命名约定保持一致。

### 单个 Tracer Bullet 执行

```
1. 从 prompt 中获取 task 目标和验收标准
2. 实现（全栈：DB → API → UI）
3. 写关键单测（覆盖核心逻辑路径，不追求覆盖率）
4. 验证:
   a. 编译通过（tsc --noEmit / pnpm build / 对应语言的编译检查）
   b. 单测通过（仅跑当前变更相关的测试，不跑全量）
   c. Code smell 扫描:
      grep -rn "TODO\|FIXME\|HACK\|XXX\|console\.log\|debugger" {变更文件}
      发现遗留 → 清理
5. IF 全部通过 → 汇报完成
6. IF 失败 → 修复 → 重试（max 2 次）
7. IF 2 次仍失败 → 汇报失败原因
```

### 验证边界（做什么 / 不做什么）

| ✅ 做 | ❌ 不做 |
|--------|---------|
| 核心逻辑的单测 | 追求覆盖率 |
| 编译/构建检查 | 全量测试套件 |
| Code smell 清理 | 集成测试（E2E 覆盖） |
| 当前变更相关的测试 | 反假跑检查 |
| | 验证证据文件 |
| | Checkpoint 管理（由 workflow spec-progress 节点负责） |

## 完成输出

task 执行完成后，汇报结果:
- 通过: 列出完成的验收标准和关键变更
- 失败: 说明失败原因和已尝试的修复
```
