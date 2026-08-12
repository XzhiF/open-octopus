# Superpowers /loop 机制调研报告

> 调研日期: 2026-08-05
> 调研员: External Research Agent
> 目标: 为 Octopus WorkflowEngine harness 获取 loop 机制参考

## 概述

"Superpowers" 是 Claude Code 生态中两个不同但相关的概念交叉点:

1. **Claude Code 原生 `/loop` 命令** — 内置的会话级定时调度系统，由 `CronCreate`/`CronList`/`CronDelete` 三个内部工具支撑。将 Claude Code 从"请求-响应"工具转变为持续运行的后台 agent。
2. **Superpowers 插件** (by Jesse Vincent/obra, GitHub 200k+ stars) — 一个 agentic skills 框架，通过结构化的开发方法论（review-fix loop、verification gate、systematic debugging）实现工程级代码质量。它本身不包含 `/loop` 命令，但其内部的 **fix loop**（修复循环）和 **subagent-driven development** 模式是 loop engineering 的最佳实践参考。

此外，本项目 (Octopus) 已经有一个成熟的 `matt-pipeline-loop` 技能，实现了 **verification-driven iteration orchestration**（验证驱动的迭代编排），这是一个比 superpowers 更完整的 loop 实现。

本报告综合三个来源的调研结果。

---

## 1. 循环调度机制

### 1.1 Claude Code 原生 `/loop` — 会话级调度

**来源**: Claude Code 官方文档 (code.claude.com), claudefa.st 指南

#### 启动方式

```bash
# 基本语法: /loop [间隔] [任务描述]
/loop 5m check the CI status on PR #247
/loop 10m babysit my open PRs
/loop 1h /review-pr 1234

# 间隔语法:
# - 前置时间: /loop 30m check the build
# - 后置 every: /loop check the build every 2 hours
# - 无间隔: /loop check the build (Claude 自适应节奏)

# Cron 表达式:
/loop "run tests" --cron "0 9 * * 1-5"

# 自然语言定时:
remind me at 3pm to push the release branch
in 45 minutes, check whether the integration tests passed
```

**支持的时间单位**: `s`(秒,向上取整到分钟), `m`(分钟), `h`(小时), `d`(天)

#### 内部实现 — CronCreate/CronList/CronDelete

`/loop` 命令是这三个内部工具的语法糖层:

| 工具 | 功能 |
|------|------|
| `CronCreate` | 使用 5 字段 cron 表达式和 prompt 调度新任务 |
| `CronList` | 列出所有已调度任务的 ID、调度计划和 prompt |
| `CronDelete` | 通过 8 字符 ID 取消任务 |

**关键架构决策**:
- **进程绑定(process-bound)**: 调度在 Claude Code 进程内部管理，不是操作系统级别
- **非持久化**: 关闭终端或退出 Claude Code 会立即销毁所有已调度任务
- **顺序执行**: 多个 loop 串行运行，一个慢任务会延迟下一个

#### 调度策略

| 策略 | 详情 |
|------|------|
| **固定间隔** | 用户指定 `5m`、`10m`、`1h` 等 |
| **自适应节奏** | 省略间隔时 Claude 自行决定每次运行的时机 |
| **Cron 表达式** | 标准 5 字段 cron，如 `"0 9 * * 1-5"` (工作日9点) |
| **一次性提醒** | 自然语言定时，转为固定 cron 表达式 |

**来源**: https://code.claude.com/docs/en/scheduled-tasks, https://claudefa.st/blog/guide/development/scheduled-tasks

### 1.2 Superpowers 插件 — Fix Loop (修复循环)

**来源**: `skills/subagent-driven-development/SKILL.md`

Superpowers 的 fix loop 是一个**有界迭代循环**，发生在 code review 之后:

```
实现者完成任务 → 审查者评审 → 发现问题 → 修复循环启动
                                         │
                    ┌─────────────────────┘
                    ▼
            Round 1-3: 恢复原实现者修复
            Round 4-5: 换更强模型+新实现者
                    │
                    ▼
            重新审查(范围限定)
                    │
            ┌───────┴───────┐
            │ 全部修复?     │
            │ YES → 完成    │
            │ NO  → 下一轮  │
            │ Round=5? → 断路器跳闸 → 裁决 |
            └───────────────┘
```

**调度策略**: 事件驱动（review 发现问题时触发），非定时轮询

### 1.3 Octopus matt-pipeline-loop — 验证驱动迭代

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

这是本项目已有的成熟实现，结合了 Anthropic EDD、Shumer Gauntlet 和 Loop Engineering 模式:

```
Pipeline 执行 → 验证报告 → 5层收敛检查
                           │
               ┌───────────┴───────────┐
               │ 全部通过?             │
               │ YES → GO 退出         │
               │ NO → 生成 gap brief   │
               │     → 新 feature slug │
               │     → 重新执行 pipeline│
               └───────────────────────┘
```

**调度策略**: 事件驱动 + 自动继续（score < threshold 时自动启动下一轮）

---

## 2. 监控与检测

### 2.1 Claude Code `/loop` — 用户定义的监控

`/loop` 本身不预定义监控内容。用户通过 prompt 定义监控逻辑:

```bash
# PR 监控
/loop 10m babysit my open PRs:
For each PR I'm assigned to:
1. Check if CI has run since last check
2. If CI failed: read error logs, identify root cause, create minimal fix
3. Check for new review comments
4. Update .pr-state.json with current status

# 代码质量监控
/loop 30m review files changed in the last git commit and flag any functions over 50 lines

# 测试失败分析
/loop 2h run npm test and if any tests fail, identify the most likely cause

# 安全监控
/loop 24h run npm audit and list any high or critical vulnerabilities

# 文档漂移检测
/loop 1d compare API documentation in /docs with current function signatures in /src/api
```

**检测模式**: 每次 tick 时 Claude 以完整上下文执行 prompt，如同用户手动输入

### 2.2 Superpowers — 内置验证门控

**来源**: `skills/verification-before-completion/SKILL.md`, `skills/systematic-debugging/SKILL.md`

Superpowers 的监控不是时间驱动的，而是**事件门控**:

| 门控点 | 检测内容 | 来源 |
|--------|---------|------|
| **Verification Gate** | 测试是否真正通过、构建是否成功、lint 是否干净 | verification-before-completion |
| **Code Review Gate** | Spec 合规性 + 代码质量双重审查 | subagent-driven-development |
| **Fix Loop Monitor** | 修复是否真正解决了问题，是否引入新问题 | subagent-driven-development |
| **Architecture Check** | 3+ 次修复失败 → 架构问题检测 | systematic-debugging |

**核心原则**: "Evidence before claims, always" — 没有运行验证命令就不能声称通过

```
BEFORE claiming any status:
1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
5. ONLY THEN: Make the claim
```

### 2.3 Octopus matt-pipeline-loop — 5层收敛检测

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

这是最结构化的检测方案:

| 层 | 检测项 | 失败动作 |
|----|--------|---------|
| L1 | Pipeline 完整性 (spec.md + issues/ + pipeline-report.md 全存在) | NO-GO |
| L2 | Carryover 清除 (前几轮未 PASS 的 AC 现在是否 PASS) | 阻止收敛 |
| L3 | 无 SKIP AC (零个 AC 状态为 SKIP) | 阻止收敛 |
| L4 | E2E 执行证据 (Playwright 真正运行了，不只是写了测试) | 阻止收敛 |
| L5 | 分数 ≥ 85 (adjusted score) | CONTINUE |

---

## 3. 约束与保护

### 3.1 Claude Code `/loop` 约束

**来源**: Claude Code 官方文档, claudefa.st, Medium 分析

| 约束 | 详情 | 设计意图 |
|------|------|---------|
| **3天自动过期** | 每个循环任务在 3 天后自动删除 | 防止遗忘的循环无限消耗 API 额度 |
| **会话作用域** | 关闭终端 = 循环立即死亡 | 零配置便利，不需要持久化 |
| **最多 50 个任务/会话** | 单会话上限 | 资源保护 |
| **无追赶机制** | Claude 忙时错过触发，空闲时只运行一次 | 防止积压执行 |
| **环境变量开关** | `CLAUDE_CODE_DISABLE_CRON=1` 完全禁用 | 一键关闭所有自动调度 |
| **权限继承** | 循环继承会话权限，不能绕过 | 安全边界 |

**成本约束示例**:
```
短间隔的成本复合效应:
$0.05/cycle × every 5 min = $14.40/day
```

**来源**: https://claudefa.st/blog/guide/development/scheduled-tasks

### 3.2 Superpowers Fix Loop 约束

**来源**: `skills/subagent-driven-development/SKILL.md`

| 约束 | 详情 | 设计意图 |
|------|------|---------|
| **5轮上限** | 每个任务最多 5 轮修复-审查循环 | 防止无限修复尝试 |
| **断路器机制** | Round 5 仍有问题 → 停止派遣，进入裁决 | 识别结构性问题而非表面 bug |
| **模型升级** | Round 4-5 切换到更强模型 | 能力瓶颈而非重复尝试 |
| **新眼睛原则** | Round 4+ 用全新实现者而非恢复原实现者 | "循环存活3轮通常意味着实现者看不到自己的问题" |
| **范围限定审查** | 重审查只检查修复 diff，不漫游 | 防止审查循环无限扩展 |
| **裁决机制** | 断路器跳闸后，控制器自行裁决每个发现 | 区分"审查者错了"、"真实但可延期"、"真实且承重" |

**裁决规则**:
```
断路器跳闸时 (Round 5 仍有开放发现):
- 审查者错了/可争议 → park (记录裁决)
- 真实但下游不依赖 → park (标注延期)
- 真实且承重 → STOP, 报告 BLOCKED 给人类
```

### 3.3 Octopus matt-pipeline-loop 约束

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

| 约束 | 检测方式 | 动作 |
|------|---------|------|
| **最大迭代数** | `iteration_count ≥ max_iterations` (默认5) | EXIT (MAX_REACHED) |
| **无进展检测** | 连续2轮 < 5分改善 | EXIT (STALLED) |
| **分数回退** | 当前分数 < 前一轮分数 | EXIT (REGRESSION) |
| **预算耗尽** | 用户指定的 token/cost 限制达到 | EXIT (BUDGET_EXHAUSTED) |
| **BLOCKED 检测** | 同一 gap 连续2+轮无改善 | 标记 BLOCKED，从下一轮排除 |
| **SKIP = 硬阻断** | 任何 AC 状态为 SKIP | 阻止收敛，成为 P0 目标 |

---

## 4. 错误处理与自动纠错

### 4.1 Claude Code `/loop` — 最小化错误处理

**来源**: Medium 分析, claudefa.st

```
错误 → 在会话输出中报告 → 下一个调度周期仍然尝试
```

**设计哲学**: 极简主义

- **无自动重试**: 失败的周期不会重试
- **无原生告警**: 输出绑定在终端，需要外部日志监控
- **无恢复机制**: 错过就跳过
- **推荐模式**: 在 prompt 中嵌入错误检查

```bash
# 推荐: 在 prompt 中嵌入错误处理
/loop "if this command fails, output the string ERROR followed by the reason" --interval 5m

# 推荐: 输出到外部监控
/loop "check for deprecated imports and output ONLY a JSON array" --interval 1h
```

**生产级替代方案**:
```bash
#!/bin/bash
# claude-daily-check.sh — 系统级 cron 替代
cd /path/to/project
claude -p "summarize all commits from last 24 hours" >> /var/log/claude-daily.log 2>&1
```
配合 crontab:
```
0 8 * * 1-5 HOME=/home/user /path/to/claude-daily-check.sh
```

### 4.2 Superpowers — 分级错误处理

**来源**: `skills/subagent-driven-development/SKILL.md`, `skills/systematic-debugging/SKILL.md`

#### 实现者报告处理 (4种状态)

| 状态 | 处理方式 |
|------|---------|
| **DONE** | 生成审查包 → 派遣审查者 |
| **DONE_WITH_CONCERNS** | 读取关注点 → 正确性问题先处理，观察性问题记录后继续 |
| **NEEDS_CONTEXT** | 提供缺失上下文 → 重新派遣 |
| **BLOCKED** | 评估阻断原因 → 提供更多上下文/更强模型/拆分任务/上报人类 |

**关键规则**: "Never ignore an escalation or force the same model to retry without changes. If the implementer said it's stuck, something needs to change."

#### 系统化调试 (4阶段)

**来源**: `skills/systematic-debugging/SKILL.md`

```
Phase 1: 根因调查 (必须先于任何修复)
  ├── 仔细阅读错误信息
  ├── 稳定复现
  ├── 检查最近变更
  ├── 多组件系统: 每层加诊断探针
  └── 追踪数据流

Phase 2: 模式分析
  ├── 找到工作示例
  ├── 对比参考实现
  ├── 识别差异
  └── 理解依赖

Phase 3: 假设与测试
  ├── 形成单一假设
  ├── 最小化变更测试
  └── 一次一个变量

Phase 4: 实现
  ├── 创建失败测试用例
  ├── 实施单一修复
  ├── 验证修复
  └── 3+ 次失败 → 质疑架构
```

**3次修复失败规则**:
```
if fix_attempts >= 3:
  STOP
  Question fundamentals:
  - Is this pattern fundamentally sound?
  - Are we sticking with it through sheer inertia?
  - Should we refactor architecture vs. continue fixing symptoms?
  → Discuss with human partner before attempting more fixes
```

### 4.3 Octopus matt-pipeline-loop — 自动纠错

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

#### Gap Brief 生成 (自动纠错核心)

当验证报告显示 gap 时，自动生成针对性的 gap brief:

```
verification-report 解析 → 提取 gap → 分类优先级 → 生成 gap brief
                                                          │
                                    ┌─────────────────────┘
                                    ▼
                            P0: BLOCKED/SKIP/Regression → 最先修复
                            P1: 缺少验证 → 第二修复
                            P2: 陈旧工件 → 第三修复
                            P3: 质量提升 → 最后修复
```

**每轮预算**: 3-5 个 gap items/轮。过多=上下文过载，过少=进展太慢

#### 反假收敛机制

| 条件 | 覆盖规则 |
|------|---------|
| "tests written but not executed" | 该 AC = 0%，不是 50% |
| Browser E2E 存在但从未运行 | E2E gate = FAIL |
| pipeline-report.md 缺失 | 迭代无效，adjusted score = 0 |

#### Carryover 追踪

```markdown
| AC# | Previous Status | Round Found | Round Fixed | Current Status |
|-----|----------------|-------------|-------------|---------------|
| AC-14 | SKIP | R1 | — | — |        # 仍未修复
| AC-6 | PARTIAL | R1 | R2 | PASS |         # R2 修复
```

**规则**: 任何 carryover AC 仍为 SKIP/PARTIAL/FAIL → 阻止收敛，无论分数多高

---

## 5. 状态管理

### 5.1 Claude Code `/loop` — 无内置状态管理

**来源**: claudefa.st, Medium 分析

- **内存态**: 所有状态存在于 Claude Code 进程的内存中
- **无序列化**: CLI cron 任务没有持久化状态文件
- **无跨会话共享**: 一个会话的任务对另一个会话不可见
- **上下文累积**: 每次循环运行都在同一个会话上下文中累积

**上下文漂移问题**:
```
每次循环运行 → 上下文增长 → token 成本增加 + 质量下降
```

**缓解方案**:
```bash
# 定期压缩
/compact   # 压缩会话历史

# 使用 tmux 保持会话持久
tmux new -s claude-loop
claude
# 运行 /loop 命令, Ctrl+B,D 分离
```

### 5.2 Superpowers — Ledger (台账) 系统

**来源**: `skills/subagent-driven-development/SKILL.md`

Superpowers 使用**文件级持久化**作为恢复映射:

```
<repo-root>/.superpowers/sdd/<plan-basename>/
  ├── progress.md          # Ledger — 进度记录
  ├── task-N-brief.md      # 任务简报
  ├── task-N-report.md     # 任务报告
  └── review-package-N.md  # 审查包
```

**Ledger 格式**:
```markdown
# SDD ledger — plan: docs/plans/feature-plan.md

Task 1: complete (commits a1b2c3d..d4e5f6a, review clean)
Task 2: fix round 1/5 (2 addressed, 0 open; commits d4e5f6a..b7c8d9e)
Task 2: complete (commits d4e5f6a..b7c8d9e, review clean)
Task 3: fix round 2/5 (1 addressed, 1 open — magic number; commits ...)
```

**关键设计**:
- "Conversation memory does not survive compaction" — 上下文压缩后会丢失
- "The ledger is your recovery map: the commits it names exist in git even when your context no longer remembers creating them"
- "After compaction, trust the ledger and `git log` over your own recollection"
- `git clean -fdx` 会销毁 workspace，但可以从 `git log` 恢复

### 5.3 Octopus matt-pipeline-loop — 最完整的状态管理

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

#### 多层状态文件

| 文件 | 内容 | 生命周期 |
|------|------|---------|
| `loop-state.json` | 轮次、分数、carryover、状态 | 整个 loop |
| `carryover.md` | 跨轮次未 PASS 的 AC 追踪 | 整个 loop |
| `iteration-handoff.md` | 保护性上下文(决策、接口、路径) | 每轮 |
| `loop-summary.md` | 最终总结 | loop 退出时 |

#### Context Hygiene (上下文卫生)

```
每轮迭代后:
  6.5.1 写入 iteration-handoff.md (保护性上下文)
  6.5.2 提交工件到 git
  6.5.3 选择性重读 (只读下一轮需要的)
  6.5.4 验证上下文定位 (4行 sanity check)
```

**选择性上下文加载 (~20k tokens)**:
| 加载 | 不加载 |
|------|--------|
| loop-state.json (~1k) | 前几轮的 pipeline-report.md |
| 最新 iteration-handoff.md (~3k) | 前几轮的 issues/ tickets |
| carryover.md (~1k) | E2E 截图/测试日志 |
| 下一轮 gap brief (~5k) | 前几轮 code review 发现 |
| spec.md 相关段落 (~10k) | 完整 spec.md |

---

## 6. 通知与报告

### 6.1 Claude Code `/loop` — 终端绑定

**来源**: Medium 分析, claudefa.st

- **输出绑定终端**: 所有输出显示在 Claude Code 会话中
- **无原生通知**: 不能发送邮件、Slack 等
- **变通方案**: 通过 shell 工具 (`curl`/webhooks) 发送外部通知

```bash
# 通过 curl 发送 Slack 通知
/loop "check CI status; if failed, curl -X POST $SLACK_WEBHOOK -d 'CI failed'" --interval 5m
```

### 6.2 Superpowers — Ledger 即报告

**来源**: `skills/subagent-driven-development/SKILL.md`

- **Ledger 条目**: 每个任务、每轮修复、每个裁决都记录在 progress.md
- **Final Review**: 整个分支的最终审查报告
- **Deferred Minor List**: 延期项汇总，供最终审查分诊
- **BLOCKED 报告**: 承重问题上报给人类

**报告格式示例**:
```
Implementation complete. What would you like to do?

1. Merge back to main locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
```

### 6.3 Octopus matt-pipeline-loop — 结构化报告

**来源**: `.claude/skills/matt-pipeline-loop/SKILL.md`

#### Loop Summary (退出时生成)

```markdown
# Loop Summary — chatbot-workflow-design

## Iteration History
| Round | Feature Slug | Score | Adjusted | Decision | Key Fix |
|-------|-------------|-------|----------|----------|---------|
| 1 | chatbot-workflow-design | 50 | 50 | NO-GO | Initial |
| 2 | chatbot-workflow-design-r2 | 72 | 72 | REVIEW | Unit tests |
| 3 | chatbot-workflow-design-r3 | 88 | 78 | REVIEW | Negative tests |

## Score Progression
50 → 72 (+22) → 88 (+16)

## Carryover History
| AC# | First Seen | Final Status | Rounds to Fix |
|-----|-----------|-------------|---------------|
| AC-6 | R1 | PASS | 2 |
| AC-14 | R1 | SKIP | — (still open) |
```

#### 迭代间 Sanity Check

```
📍 Round 3/5 | Score: 88/100 (adjusted: 78/100) | Branch: feat/interaction-node
🎯 Gap targets: negative-tests, e2e-execution
🔄 Carryover: 1 ACs still not PASS (AC-14)
📂 Artifacts: .scratch/chatbot-workflow-design-r3/
```

---

## 7. 可借鉴的设计模式

### 7.1 对 Octopus WorkflowEngine Harness 的启发

基于三个来源的综合分析，以下模式最值得借鉴:

#### 模式 1: 5要素 Loop 契约 (来自 Loop Engineering)

```
Trigger → Scope → Action → Budget → Stop → Report
```

每个 loop 必须定义:
- **Trigger**: 什么触发循环 (时间/事件/验证失败)
- **Scope**: 循环做什么 (gap 修复 vs 全量重做)
- **Action**: 循环内的具体动作
- **Budget**: 资源上限 (迭代数/token/cost)
- **Stop**: 退出条件 (收敛/停滞/回退/超时)
- **Report**: 结果报告格式

#### 模式 2: Ledger 优先于内存 (来自 Superpowers)

**原则**: "Conversation memory does not survive compaction"

```
harness 设计启示:
- 每次循环迭代的状态必须写入磁盘
- 上下文压缩后从文件恢复，不依赖记忆
- Git history 是最终真相源
```

#### 模式 3: 断路器 + 裁决 (来自 Superpowers Fix Loop)

```
harness 设计启示:
- 固定上限 (N 轮) 防止无限循环
- 达到上限后不是简单失败，而是进入"裁决"模式
- 区分: 可争议/可延期/承重 — 三种不同处理
- 承重问题必须 STOP，不能继续
```

#### 模式 4: Gap-Focused 迭代 (来自 matt-pipeline-loop)

```
harness 设计启示:
- 每轮只修复失败的部分，不全量重做
- Carryover 追踪确保"遗漏的项"不会被遗忘
- 反假收敛: "tests written ≠ tests executed"
- 选择性上下文加载: 只加载需要的，不全量加载
```

#### 模式 5: 3天过期 + 无追赶 (来自 Claude Code /loop)

```
harness 设计启示:
- 时间边界: 任何 loop 必须有最大存活时间
- 无追赶: 错过的执行不堆积，空闲时只运行一次
- 环境变量一键禁用: CLAUDE_CODE_DISABLE_CRON=1
- 成本意识: 短间隔的成本复合效应需要预警
```

#### 模式 6: Worktree 隔离 (来自 Superpowers + PR babysitting)

```
harness 设计启示:
- 修复动作在隔离 worktree 中执行，不污染主工作区
- 每个任务一个独立 worktree
- 完成后 clean up 或保留供人类迭代
```

#### 模式 7: Context Hygiene (来自 matt-pipeline-loop)

```
harness 设计启示:
- 每轮迭代后写 handoff 文件
- 保护性上下文(架构决策、已确认接口)必须跨轮存活
- 提交工件到 git 作为恢复点
- 迭代开始前做 sanity check 确认定位正确
```

### 7.2 建议的 Harness 架构

综合所有模式，建议 Octopus WorkflowEngine Harness 采用以下架构:

```
┌─────────────────────────────────────────────┐
│  Harness Controller                          │
│                                              │
│  ┌─ Loop Contract ─────────────────────┐    │
│  │ trigger: verification_fail | timer   │    │
│  │ scope: gap_fix | full_rerun          │    │
│  │ budget: max_iter=5, token_limit=100k │    │
│  │ stop: converged|stalled|regression   │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─ State Spine (Ledger) ──────────────┐    │
│  │ iteration-N.json    (当前轮状态)      │    │
│  │ carryover.json      (跨轮追踪)       │    │
│  │ handoff.md          (保护性上下文)    │    │
│  │ progress.md         (台账)           │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─ Execution Engine ──────────────────┐    │
│  │ 1. Read state from disk             │    │
│  │ 2. Generate gap brief (if needed)   │    │
│  │ 3. Execute workflow (isolated)      │    │
│  │ 4. Run verification                 │    │
│  │ 5. Check convergence (5 layers)     │    │
│  │ 6. Write state to disk              │    │
│  │ 7. Circuit breaker check            │    │
│  │ 8. Continue or Exit                 │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─ Protection Layer ──────────────────┐    │
│  │ max_iterations: hard cap            │    │
│  │ time_boundary: max runtime          │    │
│  │ no_progress_detector: 2 rounds      │    │
│  │ regression_detector: score ↓         │    │
│  │ cost_ceiling: token budget          │    │
│  │ kill_switch: env var                │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─ Reporter ──────────────────────────┐    │
│  │ Per-iteration: sanity check         │    │
│  │ On-exit: loop-summary.md            │    │
│  │ Notifications: hermes/webhook       │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

---

## 源码/文档引用

### Claude Code 原生 `/loop`

| 来源 | URL | 内容 |
|------|-----|------|
| Claude Code 官方文档 | https://code.claude.com/docs/en/scheduled-tasks | 官方 scheduled tasks 文档 |
| claudefa.st 指南 | https://claudefa.st/blog/guide/development/scheduled-tasks | 最详细的 /loop 技术指南 |
| Medium 分析 | https://medium.com/@yuxiaojian/beyond-the-ai-cron-job-how-claude-codes-loop-works-and-the-rise-of-loop-engineering-c9a80976b17b | 内部机制深度分析 |
| mindstudio.ai | https://www.mindstudio.ai/blog/what-is-claude-code-loop-command-recurring-tasks | PR babysitting 用例 |
| Reddit 讨论 | https://www.reddit.com/r/ClaudeCode/comments/1rn94wp/ | 社区反馈 |
| Claude Code Power Tips | https://support.claude.com/en/articles/14554000 | Anthropic 官方使用建议 |

### Superpowers 插件 (obra/superpowers)

| 来源 | URL | 内容 |
|------|-----|------|
| GitHub 仓库 | https://github.com/obra/superpowers | 完整源码 |
| subagent-driven-development | `skills/subagent-driven-development/SKILL.md` | Fix loop 核心实现 |
| verification-before-completion | `skills/verification-before-completion/SKILL.md` | 验证门控 |
| systematic-debugging | `skills/systematic-debugging/SKILL.md` | 系统化调试 |
| executing-plans | `skills/executing-plans/SKILL.md` | 计划执行 |
| receiving-code-review | `skills/receiving-code-review/SKILL.md` | 审查反馈处理 |
| dispatching-parallel-agents | `skills/dispatching-parallel-agents/SKILL.md` | 并行 agent 派遣 |
| finishing-a-development-branch | `skills/finishing-a-development-branch/SKILL.md` | 分支完成 |
| Datawhale 教程 | https://datawhalechina.github.io/easy-vibe/en/stage-3/core-skills/superpowers/ | 技能概览 |

### Octopus 本地实现

| 来源 | 路径 | 内容 |
|------|------|------|
| matt-pipeline-loop | `.claude/skills/matt-pipeline-loop/SKILL.md` | 验证驱动迭代编排 |
| loop-me | `.claude/skills/loop-me/SKILL.md` | Loop lens 设计方法论 |
| hitl-loop template | `.claude/skills/diagnosing-bugs/scripts/hitl-loop.template.sh` | 人在环中循环模板 |

---

## 附录: 对比矩阵

| 维度 | Claude Code /loop | Superpowers Fix Loop | Octopus matt-pipeline-loop |
|------|-------------------|---------------------|--------------------------|
| **触发方式** | 时间间隔 / cron | 事件(review 发现) | 事件(验证失败) |
| **调度粒度** | 秒~天 | 即时(发现即修复) | 即时(score < threshold) |
| **状态持久化** | 无(内存) | Ledger (文件) | JSON + Markdown + Git |
| **最大迭代** | 3天时间 | 5轮修复 | 5轮迭代(可配) |
| **错误处理** | 报告，不重试 | 升级模型，新实现者 | Gap brief，全 pipeline 重跑 |
| **上下文管理** | 累积(需手动 /compact) | Ledger 恢复 | Handoff + 选择性加载 |
| **通知** | 终端输出 | Ledger 条目 | Hermes + 文件报告 |
| **隔离** | 无 | Worktree | Feature slug + worktree |
| **反假收敛** | 无 | 裁决机制 | 5层收敛检查 |
| **成本意识** | 用户自管 | 模型选择策略 | Token budget 上限 |
| **适用场景** | 通用监控/轮询 | 代码修复循环 | 端到端交付验证 |
