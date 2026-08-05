# 01 — Harness 智能模型：谁来做决策？

Type: grilling
Status: resolved
Blocked by: None

## Question

Harness 的"大脑"在哪里？当检测到异常时，谁来决定该怎么干预？

## Answer

**结论：三层委托架构**

```
Layer 1: 监控层 (Detectors)
├─ 检测器插件，每个检测一种异常模式
├─ 产出: DiagnosisReport (结构化诊断)
├─ 可配置: 阈值、启用/禁用
└─ 可观测: 每次检测都发 SSE 事件

Layer 2: 策略层 (Strategies)
├─ 可配置的策略映射表 (YAML/JSON)
├─ diagnosis → strategy → action
├─ 内置策略: pause/skip/retry/switch
└─ 自定义策略: 用户可注册新策略

Layer 3: 委托层 (Agent Delegation)
├─ 调用 Octopus 内置 Agent 分身 (octopus_agent)
├─ 分身拿到 DiagnosisReport + 上下文
├─ 分析、推理、生成干预方案
└─ 执行干预 (brief→新session→续跑)
```

**关键设计约束**:
1. 规则/策略不硬编码在 TypeScript 中 → 用 YAML/JSON 配置
2. LLM 层直接复用 Octopus 内置 Agent 系统，不重新造
3. 所有层次的决策都通过 SSE 事件可观测
4. 策略层处理 80% 常见场景（快+便宜），委托层处理 20% 复杂场景（慢+智能）
