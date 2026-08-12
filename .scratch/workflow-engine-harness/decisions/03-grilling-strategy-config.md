# 03 — 策略配置格式与存储

Type: grilling
Status: resolved
Blocked by: 01

## Question

策略配置放在哪里？格式是什么？

## Answer

**核心原则: Harness 是引擎/系统的事，不是 workflow 的事。workflow.yaml 不加任何 harness 配置。**

### 配置文件结构

```
packages/shared/harness-defaults.yaml   → 随代码版本发布的默认配置
~/.octopus/harness.yaml                 → 用户实例的实际配置 (可编辑)
```

### 配置格式 (harness.yaml)

```yaml
detectors:
  stupid_retry:
    enabled: true
    threshold: 2
  model_mismatch:
    enabled: true
  timeout_cascade:
    enabled: true
    threshold: 3
  cost_runaway:
    enabled: true
    budget_usd: 10

strategies:
  - match: stupid_retry
    actions: [inject_message, retry_different_approach]
  - match: model_mismatch
    actions: [switch_model]
  - match: "*"
    actions: [pause_and_notify]
    delegate_to_agent: true
```

### 系统管理 UI
- 新增 "Harness 配置" 菜单
- 类似现有的模型管理 UI
- YAML 编辑器 + 实时验证
- 保存后立即生效（正在运行的 execution 不受影响）

### Setup 智能合并
- `packages/shared/harness-defaults.yaml` 随版本发布
- `setup` 命令执行三方合并:
  - 旧默认 vs 新默认 → 知道框架改了什么
  - 旧默认 vs 用户当前 → 知道用户自定义了什么
  - 合并: 新增默认项 + 保留用户自定义 + 冲突标记

### 未来: 经验升级 (Phase 2+)
- 执行数据 → 分析常见失败模式 → 自动建议新阈值/策略
- 用户可选择接受或忽略建议
- 经验配置存在 harness.yaml 的特定 section，与手动配置区分
