---
name: octo-xzf-decomposer
description: "Feature 分解方法论 — 大需求拆解为有序 Feature Map + 接口约定"
category: coding-assistant
tags: [xzf-dev, xzf-genesis]
version: 1.0.0
---

# Feature 分解方法论

## 触发条件
xzf-genesis workflow 的 `feature-decomposition` 节点。将大需求分解为有序的 feature 列表。

## 输入

- **Idea 文档**: `.octopus/xzf/{feature}/00-init/idea.md`
- **Research Brief**: `.octopus/xzf/{feature}/01-research/research-brief.md`
- **Workspace 拓扑**: `.octopus/xzf/{feature}/00-init/workspace-topology.md`

## 分解原则

### 1. 功能完整性优先
每个 feature 必须是一个**完整可交付的用户故事线**，不是技术层切片。
- ✅ "用户能注册登录并管理 profile"
- ❌ "搭建数据库 schema"（这是 task，不是 feature）

### 2. 共享基础设施先行
识别多个 feature 共用的基础模块，作为第 0 批 feature：
- monorepo 结构、共享类型、CI 配置
- 通用认证/权限框架
- 共享 UI 组件库/设计系统

### 3. 依赖排序
feature 按依赖拓扑排序：
- 无依赖的 feature 排前面
- 有依赖的 feature 排在被依赖者之后
- 同层级的 feature 按复杂度从低到高排列

### 4. 粒度控制
- 每个 feature 预估 2-5 个 specs
- 单个 feature 不应超过一次 xzf-dev pipeline 的处理能力
- 如果一个 feature 太大 → 继续拆分

## 输出: feature-map.md

写入: `.octopus/xzf/{feature}/02-clarification/feature-map.md`

```markdown
# Feature Map

> 生成时间: {ISO timestamp}
> 总 Features: {N}
> Idea: {一句话概述}

## 共享基础设施
| # | Feature | 范围 | 依赖 | 预估 specs |
|---|---------|------|------|-----------|
| F0 | {名称} | {范围描述} | 无 | {N} |

## 核心功能
| # | Feature | 范围 | 依赖 | 预估 specs |
|---|---------|------|------|-----------|
| F1 | {名称} | {范围描述} | F0 | {N} |
| F2 | {名称} | {范围描述} | F0 | {N} |

## Feature 间接口约定
| 提供方 | 消费方 | 接口 | 说明 |
|--------|--------|------|------|
| F1 | F3 | AuthService(userId, token) | 认证服务 |
| F2 | F3 | ProductService(id, price) | 商品查询 |

## 全局约束
- {跨 feature 的技术约束}
- {性能/安全/兼容性要求}
```

## Feature 范围文件

为每个 feature 生成独立的范围文件，供 per-feature pipeline 使用：

写入: `.octopus/xzf/{feature}/02-clarification/features/F{N}-scope.md`

```markdown
# F{N}: {Feature 名称}

## 范围
{这个 feature 做什么，用户视角}

## 不包含
{明确排除的范围}

## 依赖
- 前置 feature: {F0, F1, ...}
- 需要的接口: {从接口约定表提取}

## 接口提供
{本 feature 暴露给后续 feature 的接口}

## 验收标准
- [ ] {用户可验证的条件}

## 约束
- {本 feature 的特殊约束}
```

## 完成输出

```json
{"vars_update": {"feature_count": N}}
```

## 质量检查

1. 每个 feature 是否完整可交付（不是技术切片）？
2. 依赖关系是否有环？（有环说明拆分有问题）
3. 共享基础设施是否覆盖了所有共用模块？
4. 接口约定是否足够后续 feature 实现？
5. 每个 feature 是否在一次 pipeline 能力范围内？
6. 是否避免了文件路径和实现细节？
