---
name: octo-xzf-spec-to-tasks
description: "从已 audit 的 specs 出 tracer bullet tasks + spec-index + e2e-test-plan"
category: coding-assistant
tags: [xzf-dev, spec, tasks]
version: 1.0.0
---

# Spec → Tracer Bullet Tasks 生成

## 触发条件
Stage 4c `spec-to-tasks` 节点，读已 audit（spec-audit 修过）的 specs，出每个 spec 的 tracer bullet tasks。

## 核心铁律（不可违反）

1. **垂直切片横穿全栈** — 每个 task 是一条窄而全的路径（DB→API→UI），完成后能 demo/验证。
2. **不出 E2E task** — E2E 全量验证是 `e2e-verify` 阶段的职责，不是 tracer bullet。不要造「T-N-e2e」类整体验收 task。
3. **不出 gap task** — spec-audit 已把缺口修进 spec（补了 AC/字段/路径/场景）。tasks 只实现 spec 已定义的内容，不追加「gap」补救 task。若仍发现缺口，说明 spec-audit 漏了——记到 spec-audit.md 待下一轮，不在本阶段 bolt-on task。
4. **目标驱动，不写实现路径** — task 写「用户能做什么 + 验收标准」，不写「改哪个文件」。
5. **Blocked-by 显式声明（DAG 边）** — 每个 task 声明阻塞它的 task（`## Blocked by`）。无 blocker = 立即可开始。这些边构成 DAG，下游 dag.json + 执行器据此拓扑排序成 stage 并行——不靠 LLM 运行时猜依赖。
6. **每 task fit 一个 context window** — 不要太碎也不要太庞大。
7. **基础层先行（prefactoring）** — 共享基础设施（DB schema、公共组件、让实现变容易的重构）作为 DAG 根，先做。原则："Make the change easy, then make the easy change"。
8. **宽重构例外（expand-contract）** — 机械性宽改动（改列名/改类型，blast radius 跨全局）不强行做 tracer bullet（一个 edit 破千处调用，没切片能 land green）。按 expand→migrate 分批→contract 序列：expand（新旧并存）→ 每批 migrate 一个 task（blocked by expand，CI 保持绿）→ contract（删旧，blocked by 所有 migrate）。无法单独保绿的批次共享集成分支，全 block 一个最终 integrate-and-verify task。

## 输入
- `.scratch/{feature}/03-specs/spec-index.md`（spec 列表）
- `.scratch/{feature}/03-specs/spec-NNN-{name}.md`（已 audit 的 spec，含 AC/E2E场景/数据模型/API）
- `.scratch/{feature}/03-specs/spec-audit.md`（audit 修过的 spec 变更清单，参考）

## 输出

### 1. 每个 spec 的 tracer bullet tasks
每个 task 写独立文件，放 spec 子目录：
`.scratch/{feature}/03-specs/spec-NNN-{name}/T-N-{name}.md`

⚠️ 所有 spec 必须建子目录（即使 1 个 task），下游 execution loop 靠子目录 T-N 文件发现任务。

```markdown
# T-N: {标题}

## 目标
[1-2 句话，用户视角：完成后用户能做什么]

## 验收标准
- [ ] {具体可验证条件}
- [ ] {具体可验证条件}

## Blocked by
- {前置 task id，或 "无 — 立即可开始"}
```

### Tracer Bullet 设计规则
1. **DAG 优先** — 识别可并行的独立 task，用依赖边连接，最大化并行度
2. **每个 task 独立可验证** — 完成后能 demo 或跑验证
3. **不写文件路径** — 只写用户行为和验收方式
4. **基础层先行** — 共享基础设施作为 DAG 根节点

### 2. 更新 spec-index.md
补全 Tracer Bullets 数 + 执行顺序：

```markdown
# Spec 索引

> 生成时间: {timestamp}
> 总数: {N}

| # | 文件名 | 标题 | Tracer Bullets | Depends |
|---|--------|------|---------------|---------|
| 1 | spec-001-user-login.md | 用户登录 | 3 | none |
| 2 | spec-002-dashboard.md | 仪表盘 | 4 | spec-001 |
```

execution-loop 读此文件，按 `#` 列定位第 `$iteration` 个 spec，靠子目录 T-N 文件发现 task。

### 3. E2E 测试计划
综合各 spec 的 E2E 验证场景，写 `.scratch/{feature}/03-specs/e2e-test-plan.md`：

```markdown
# E2E 测试计划

> 生成时间: {timestamp}
> 覆盖 spec: {spec 列表}

## 前置条件
- [ ] {如：后端服务已启动}
- [ ] {如：测试用户已创建}

## 全局配置
- 验证环境: {UAT / 本地 / ...}
- 测试用户: {账号信息}
- 测试数据前缀: {如 "E2E_TEST_"}

## 测试步骤

### Step 1: {步骤名} (spec-NNN)
- 页面: {URL}
- 操作: {具体操作}
- 断言: {预期结果}
- 反假跑: {真通过条件}
```

e2e-verify 直接读此文件执行。

### E2E 测试计划编制规则
1. 按 spec 依赖顺序编排步骤（基础功能先测）
2. 每步标注来源 spec 编号，方便定位失败
3. 合并可复用前置操作（如登录一次后跑多步）
4. 无 E2E 场景的 spec 不出现在计划中
5. 反假跑条件从 spec 的反假跑标准提取

### 4. DAG 声明（dag.json）— 声明式 DAG，供执行器确定性构图

每个 spec 子目录写 `dag.json`（与 T-N 文件同目录）：
`.scratch/{feature}/03-specs/spec-NNN-{name}/dag.json`

下游 `dynamic_sub_workflow` 直接读 dag.json 构图（不再让 LLM 运行时生成 DAG）→ DAG + 并行由声明保证。

```json
{
  "nodes": [
    {
      "id": "T-1",
      "type": "agent",
      "prompt": "使用 octo-xzf-implementer skill 执行 task: .scratch/{feature}/03-specs/spec-NNN-{name}/T-1-{slug}.md\n\n目标+验收标准见该文件。此阶段不跑 E2E。",
      "depends_on": []
    },
    {
      "id": "T-2",
      "type": "agent",
      "prompt": "使用 octo-xzf-implementer skill 执行 task: .../T-2-{slug}.md\n\n目标+验收标准见该文件。此阶段不跑 E2E。",
      "depends_on": ["T-1"]
    }
  ]
}
```

**dag.json 规则**：
- `id` = task 编号（T-1, T-2...），与 T-N 文件名一致。
- `type` 固定 `"agent"`。
- `prompt` 引用 T-N 文件路径（implementer 自行读取），不内联全文（保持 dag.json 小）。
- `depends_on` = 该 task 的 Blocked-by 列表（与 T-N 文件的 `## Blocked by` 一致）。
- 无依赖写 `[]`；独立 task 可并行。
- 节点顺序按依赖（blocker 先），但执行器按拓扑排序成 stage 并行，不依赖文件顺序。

## 质量检查
1. 每个 task 是否垂直切片（横穿全栈）？
2. 每个 task 验收标准是否具体可验证？
3. 是否有 E2E 整体验收 task？（应无——归 e2e-verify）
4. 是否有 gap 补救 task？（应无——缺口已在 spec 层修）
5. 依赖是否构成 DAG（无环、无依赖更晚编号的 task）？
6. spec-index.md 是否补全 task 数？
7. 每个 spec 子目录是否产了 dag.json，且 dag.json 的 depends_on 与 T-N 文件 `## Blocked by` 一致？
7. e2e-test-plan 是否覆盖所有有 E2E 场景的 spec？

## 原则
- 读 **已 audit 的 specs** 出 task——spec 已完整连贯，task 自然连贯，无 bolt-on。
- 不重新审查 spec（那是 spec-audit 的职责）；只把 spec 的 AC/E2E场景拆成可执行的垂直切片。
