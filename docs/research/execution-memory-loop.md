# Execution Memory — 让 Octopus 进入 Loop Engineering

## 1. 问题诊断

### 1.1 模块完备度

当前 Octopus 平台拥有 Loop Engineering 六大构建模块中的五个：

| 模块 | 现状 | 评估 |
|------|------|------|
| Automations | Scheduler + Cron + Agent 自注册 | ✅ 完备 |
| Worktrees | 完整 git worktree 隔离 | ✅ 完备 |
| Skills | 20+ 内置 + 本地进化 + FTS 搜索 | ✅ 完备 |
| Connectors | MCP 协议 + Hermes 通知 | ✅ 可用（单向） |
| Sub-agents | Swarm + 多角色 + maker/checker | ✅ 完备 |
| **Memory/State** | Agent 三层记忆 + experiences 表 | **⚠️ 缺少执行记忆** |

### 1.2 五个断裂点

| # | 断裂点 | 现状 | 影响 |
|---|--------|------|------|
| 1 | **Token 黑洞** | 花 50 万 token 跑的 bug-hunter，删 workspace 后统计归零 | 无法衡量 ROI |
| 2 | **经验断裂** | 上次跑出的 BUG 修复经验，下次跑时 Agent 完全不知道 | 每次冷启动 |
| 3 | **Dashboard 盲区** | 只能看"当前存活"的 workspace，删了就没了 | 无法做趋势分析 |
| 4 | **Agent 失忆** | 编排器无法基于历史执行数据做智能决策 | 无法闭环 |
| 5 | **Hermes 单向** | 只能 Octopus→Telegram 推送，不能 Telegram→Octopus 交互 | 无法远程操控 |

### 1.3 根因

```
workspace 删除 → cascadeDeleteByWorkspace() → 17 张表级联清空
  ├── executions (执行记录)
  ├── node_executions (节点执行)
  ├── node_token_usages (token 用量)
  ├── llm_calls (LLM 调用详情)
  ├── agent_events (agent 事件)
  ├── branch_executions (分支执行)
  └── ... 全部消失

而 experiences 表、evolution_log 表虽然全局保留,
但没有任何机制将执行结果写入这些表。
执行产生的知识随 workspace 消亡，系统无法积累。
```

---

## 2. 设计目标

> **每一次执行都为系统贡献持久知识，而非随 workspace 消亡。**

四个核心能力：
1. **执行归档** — workspace 删除前，自动提取并持久化执行摘要 + token + 经验
2. **经验提取** — 从海量日志中分层过滤，用低成本 LLM 提取可复用知识
3. **Loop Dashboard** — 跨 workspace 的执行历史、成本追踪、趋势分析
4. **Agent 闭环** — 编排器注入执行记忆 + Hermes 双向交互 + 自主调度

---

## 3. "经验"是什么？

经验不是日志摘要，而是**可行动的知识点**。按工作流类型：

### 3.1 bug-hunter 产生的经验

```yaml
# ── 结构化部分 (程序提取, 不需要 LLM) ──
workflow: bug-hunter
date: 2026-06-26
outcome: success
duration: 45min
cost_usd: 3.20
bugs_found: 1
pr_url: https://github.com/XzhiF/open-octopus/pull/2
bug:
  title: "agent.ts return→continue"
  severity: P1
  file: packages/engine/src/executors/agent.ts:409
  root_cause: "for...of 循环内 return 退出整个方法"
  fix: "return → continue, 一行改动"

# ── 非结构化部分 (LLM 从 node outputs 提取) ──
lessons: |
  1. swarm 节点的 host 输出不兼容 vars_update 协议 —
     如果工作流依赖 condition gate 判断, 必须确保上游节点输出格式能被引擎解析。
  2. condition target 节点必须声明 depends_on, 否则 DAG auto 模式下
     会被放在 Level 0 提前执行。引擎已修复: 自动注入隐式依赖。
  3. agency-agents-zh 的 role 名是中文, 预定义 expert 是英文,
     swarm 去重按字符串匹配会失败。建议纯动态或统一命名。
```

### 3.2 gen-workflow 产生的经验

```yaml
workflow: gen-workflow
outcome: success
cost_usd: 5.80
workflow_created: gen-workflow.yaml
node_count: 14
lessons: |
  1. 旁路节点(no-bugs-found, fix-failed)必须有 depends_on,
     否则 auto 模式下 Level 0 就执行并设置 __status: failed。
  2. swarm 节点适合并行扫描, 但 host 输出格式需要兼容 vars_update,
     否则下游 condition gate 拿到的是默认值。
  3. loop + condition gate 比 prompt 描述的"最多重试3轮"可靠得多,
     引擎原语保障执行, prompt 约束依赖 LLM 自觉性。
```

### 3.3 prd-impl / feat-dev 产生的经验

```yaml
workflow: prd-impl
outcome: completed_with_failures
cost_usd: 12.50
lessons: |
  1. E2E 测试在 worktree 环境下端口冲突概率高,
     需要预检测 3100-3598 范围可用端口。
  2. shared 包的类型变更会导致 server/web-app 构建级联失败,
     修改 shared 后必须先 pnpm build -w shared 再全量构建。
  3. opus[1m] 做实现任务时 token 消耗是 sonnet 的 4 倍,
     辅助性 sub-agent 应优先用 sonnet 控制成本。
```

### 3.4 关键区分

| 层次 | 内容 | 提取方式 | 成本 |
|------|------|---------|------|
| **结构化数据** | 状态、成本、文件列表、BUG 详情 | 程序提取（读 DB 字段） | 免费 |
| **非结构化知识** | 为什么失败、怎么避免、模式总结 | LLM 从 node outputs 提取 | haiku ~$0.01/次 |

---

## 4. 怎么从海量日志提取经验？

不是把所有日志丢给 LLM，而是**三层过滤**：

```
执行完成 (可能产生 MB 级日志)
  │
  ▼
Layer 1: 程序提取 (免费, 即时)
  ├── executions 表: status, duration, failed_nodes
  ├── node_executions 表: 每个节点的 status + duration
  ├── node_token_usages 表: 按 model 聚合 input/output/cost
  ├── node outputs: vars_update JSON (已经是结构化数据)
  └── git diff --stat: 变更文件列表
  │
  ▼
Layer 2: 规则过滤 (免费)
  ├── 只取 failed/skipped 节点的 error 字段
  ├── 只取 vars_update 中的关键变量 (conclusion, root_cause, pr_url)
  ├── 过滤掉 bash_log 噪音 (pnpm install 输出等)
  └── 如果全部成功且 cost < $1 → 跳过 LLM 提取 (不值得)
  │
  ▼
Layer 3: LLM 反思 (haiku, ~$0.01/次, 异步不阻塞)
  ├── 输入: Layer 1+2 的过滤后摘要 (通常 < 2000 tokens)
  ├── Prompt: "从以下执行摘要中提取最多 3 条可复用经验,
  │            每条经验必须是下次执行时可直接参考的行动建议"
  └── 输出: lessons_learned 文本
```

### 成本控制

| 场景 | 频率 | 单次成本 | 月成本 |
|------|------|---------|--------|
| 结构化提取 | 每次执行 | $0 | $0 |
| LLM 反思 (haiku) | 仅 cost > $1 或 failed | ~$0.01 | ~$3 (10 次/天) |
| FTS 索引更新 | 每次经验写入 | $0 | $0 |

---

## 5. 经验怎么用？

### 5.1 Agent 对话中自动注入

用户在 Telegram 说："帮我扫描一下 engine 包的 BUG"

```
OrchestratorService 处理流程:

1. 意图分类 → single_task → 匹配 bug-hunter 工作流

2. 🔥 查询执行记忆:
   SELECT * FROM execution_archive
   WHERE workflow_name = 'bug-hunter'
   ORDER BY created_at DESC LIMIT 3

3. 注入 Agent context:

   "📚 历史执行记忆:
    - 06-26: 发现 P1 BUG (agent.ts return→continue), 已修复, $3.20
    - 06-25: 未发现 BUG, $2.10
    - 06-24: 发现 P0 路径穿越漏洞, 已修复, $4.50
    
    💡 经验提示:
    - swarm 节点的 host 输出必须兼容 vars_update 协议
    - condition target 需要 depends_on 或引擎隐式依赖"

4. Agent 带着历史知识执行, 而非冷启动
```

### 5.2 智能建议

```
Agent 分析执行记忆:
  "过去 7 天 bug-hunter 在 engine 包发现了 3 个 P0-P1 BUG,
   全部跟 applyOutputsMapping 相关。
   建议对 executor 基类做一次系统性审查,
   要我创建一个审查工作流吗？"
```

### 5.3 失败预警

```
Agent 发现模式:
  "上次 gen-workflow 执行失败了, 原因是 condition target 没有 depends_on。
   这次你创建的 bug-hunter 也有同样模式,
   引擎已自动注入隐式依赖, 无需手动处理。"
```

### 5.4 成本优化建议

```
Agent 分析 token 消耗:
  "过去 30 天 bug-hunter 平均花费 $3.80/次。
   scan 节点占总成本 60% (swarm 5 专家 opus)。
   建议: scan 专家改用 sonnet, 预计降低到 $2.20/次。
   要我修改工作流吗？"
```

---

## 6. Hermes ↔ Octopus 双向交互

### 6.1 现状: 单向

```
Octopus → Hermes CLI → Telegram  (通知推送)
                          ↑ 只能看, 不能回复
```

### 6.2 目标: 双向

```
Telegram 用户发消息: "扫描 engine 包的 BUG"
       ↓
Telegram Bot (webhook 模式)
       ↓
Octopus Server: POST /agent/telegram/webhook
       ↓
Agent 处理:
  1. 识别意图 → bug-hunter
  2. 注入执行记忆上下文
  3. 创建 workspace + 执行
       ↓
Octopus → Hermes → Telegram:
  "🚀 已启动 bug-hunter (engine 包)
   📚 历史: 上次发现 1 个 P1, $3.20
   ⏱️ 预计 30-45 分钟, 会实时推送进度。"
```

### 6.3 Telegram 指令集

| 指令 | 动作 | 示例 |
|------|------|------|
| `扫描 <scope>` | 触发 bug-hunter | `扫描 engine` |
| `开发 <需求>` | 触发 feat-dev 工作流 | `开发 用户注册功能` |
| `状态` | 查询运行中的执行 | `状态` |
| `报告` | 最近 7 天执行摘要 + 成本 | `报告` |
| `经验 <关键词>` | 搜索历史经验 | `经验 CORS` |
| `注册 <工作流> <cron>` | Agent 自注册定时任务 | `注册 bug-hunter 每天2点` |
| `停止 <执行ID>` | 取消正在运行的执行 | `停止 abc123` |

### 6.4 实现方案

```typescript
// packages/server/src/routes/telegram.ts
app.post('/agent/telegram/webhook', async (c) => {
  const { message } = await c.req.json()
  
  // 转发给 Agent 处理
  const response = await agentService.processMessage({
    session_id: `telegram-${message.chat.id}`,
    message: message.text,
    source: 'telegram',
  })
  
  // 通过 Hermes 回复
  await hermes.send({
    target: `telegram:${message.chat.id}`,
    message: response.text,
  })
})
```

Hermes 需要从"通知工具"升级为"通信桥梁"——支持 webhook 接收 Telegram 消息并转发给 Octopus。

---

## 7. 自主运行的四个级别

### Level 0: 手动（现状）

```
用户手动创建 workspace → 手动选工作流 → 手动输入参数 → 手动查看结果
每一步都需要人在 web UI 上点击操作。
```

### Level 1: 消息触发（Hermes 双向后）

```
用户在 Telegram 说 "扫描 BUG"
  → Agent 自动创建 workspace + 执行
  → 实时推送进度到 Telegram
  → 完成后推送结果 + PR 链接
人只需发一条消息, 其余全自动。
```

### Level 2: 事件驱动（webhook 集成后）

```
git push → webhook → Agent 判断是否需要跑测试/扫描 → 自动执行
CI 失败 → Agent 分析日志 → 自动触发 bug-fixer
PR 合并 → Agent 触发回归测试 → 自动推送结果
由外部事件触发, 无需人参与。
```

### Level 3: 定时自治（Loop Engineering 目标）

```
┌──────────────────────────────────────────────┐
│                  Octopus Agent                │
│                                              │
│  ┌─────────┐    ┌──────────┐    ┌─────────┐ │
│  │ 观察    │───→│ 决策     │───→│ 执行    │ │
│  │ Observe │    │ Decide   │    │ Execute │ │
│  └─────────┘    └──────────┘    └─────────┘ │
│       ↑                              │       │
│       │         ┌──────────┐         │       │
│       └─────────│ 学习     │←────────┘       │
│                 │ Learn    │                 │
│                 └──────────┘                 │
└──────────────────────────────────────────────┘

观察 (Observe):
  - 读取 execution_archive 历史数据
  - 分析成功率、成本、耗时趋势
  - 识别重复模式 (同样的 BUG 反复出现)

决策 (Decide):
  - 该跑什么工作流？(基于项目状态 + 历史效果)
  - 什么参数最优？(基于历史 cost/success rate)
  - 需要通知谁？(基于结果严重度)

执行 (Execute):
  - 通过 Scheduler 注册 cron job
  - 自动创建 workspace + 执行工作流
  - Hermes 实时推送到 Telegram

学习 (Learn):
  - ArchiveService 自动归档执行结果
  - haiku 提取 lessons_learned
  - 写入 experiences 表 (FTS 可搜索)
  - 下次"观察"时读到这些经验
```

**Observe 的三种触发方式**:

| 触发方式 | 时机 | 实现 |
|---------|------|------|
| 事件触发 | 每次归档完成后 | `DomainEventBus.emit('archive:complete')` → `ObserveService.analyze()` |
| 定时调度 | 每 6 小时 | Scheduler 内置 job `agent-observe`, cron `0 */6 * * *` |
| 用户触发 | Telegram "报告" 指令或 Agent 对话 | `Agent 对话 "最近怎么样"` → 触发 Observe |

### 7.1 一个具体的自主运行场景

```
[周一 02:00] Scheduler 触发 bug-hunter (Agent 上周自注册的)

[周一 02:45] bug-hunter 完成, 发现 2 个 P2 BUG
             → ArchiveService 自动归档
             → Hermes 推送: "发现 2 个 P2, 已归档, 成本 $2.80"

[周一 09:00] 用户打开 Telegram 看到通知
             → 回复: "修复这两个 BUG"
             → Agent 读取归档数据, 获取 BUG 详情
             → 自动触发 bug-fixer, 注入修复经验

[周一 10:30] bug-fixer 完成, 修复 2 个 BUG, 创建 PR
             → ArchiveService 自动归档
             → Hermes 推送: "2 个 BUG 已修复, PR: #5"

[周一 10:31] Agent 分析执行记忆:
             → 推送: "bug-hunter 连续 3 次都在 engine 包发现 BUG,
                      建议对 engine 做一次系统性审查, 要我安排吗?"

[周二 02:00] Scheduler 再次触发 bug-hunter
             → 这次未发现 BUG (上次的已修复)
             → ArchiveService 归档, 记录 "engine 包质量改善"
             → Agent 推送: "本次无 BUG, engine 包质量持续改善 ✅"
```

---

## 8. 架构设计

### 8.1 数据流总览

```
工作流执行完成
  ↓
ArchiveService.archiveExecution()
  │
  ├── Layer 1: 程序提取 (免费)
  │   ├── execution summary (状态/耗时/节点结果)
  │   ├── token aggregation (按 model 汇总 cost)
  │   └── vars snapshot (关键输出变量)
  │
  ├── Layer 2: 规则过滤 (免费)
  │   ├── failed 节点的 error 字段
  │   └── vars_update 中的关键变量
  │
  └── Layer 3: LLM 反思 (haiku, $0.01)
      └── 提取 lessons_learned
  │
  ▼
execution_archive 表 (永久保留, 脱离 workspace 生命周期)
  │
  ├──→ Loop Dashboard API (统计/趋势/排行)
  ├──→ Agent 编排器 (注入历史经验上下文)
  ├──→ experiences 表 (FTS 搜索)
  └──→ Hermes 推送 (Telegram 通知)
  │
  ▼
workspace 可安全删除 (磁盘释放, 归档数据不受影响)
```

### 8.2 新增数据表: `execution_archive`

```sql
CREATE TABLE execution_archive (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT,  -- FTS5 需要 INTEGER PK
  id            TEXT NOT NULL UNIQUE,                -- 外部引用的 UUID

  -- 脱离 workspace 的独立记录
  org             TEXT NOT NULL DEFAULT '',
  workflow_ref    TEXT NOT NULL,
  workflow_name   TEXT NOT NULL,

  -- 执行摘要
  status          TEXT NOT NULL,          -- completed / failed / cancelled
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  duration_ms     INTEGER,

  -- 节点摘要 (JSON: [{nodeId, type, status, duration}])
  node_summary    TEXT NOT NULL DEFAULT '[]',

  -- 失败信息
  failed_nodes    TEXT,                   -- JSON array of failed node IDs
  error_message   TEXT,

  -- Token / 成本 (聚合)
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd       REAL NOT NULL DEFAULT 0,
  model_breakdown      TEXT,              -- JSON: {opus:{input,output,cost}, sonnet:{...}}

  -- 关键变量快照 (JSON: {requirement, pr_url, confirmed_bug, ...})
  vars_snapshot   TEXT NOT NULL DEFAULT '{}',

  -- LLM 提取的经验 (可搜索)
  lessons_learned TEXT,

  -- 关联
  workspace_archive_id TEXT,              -- 所属 workspace 归档
  chain_position      INTEGER,            -- 在链条中的位置 (0-based)
  parent_execution_id TEXT,               -- 父执行 (父子链)
  schedule_id         TEXT,               -- 如果由调度器触发
  clone_name          TEXT,               -- 产生此执行的分身名 (null=主Agent)

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_archive_org ON execution_archive(org);
CREATE INDEX idx_archive_workflow ON execution_archive(workflow_ref);
CREATE INDEX idx_archive_status ON execution_archive(status);
CREATE INDEX idx_archive_created ON execution_archive(created_at);
CREATE INDEX idx_archive_cost ON execution_archive(total_cost_usd);
```

### 8.3 Workspace 归档聚合层

一个 workspace 可能跑 N 个工作流，需要聚合层来保留链条关系：

```sql
CREATE TABLE workspace_archive (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  org             TEXT NOT NULL DEFAULT '',

  -- workspace 原始信息 (快照)
  workspace_name  TEXT NOT NULL,
  workspace_path  TEXT,
  created_at      TEXT NOT NULL,
  archived_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- 聚合统计
  execution_count INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,

  -- 工作流链条 (JSON)
  -- [{from: "bug-hunter", to: "bug-fixer", type: "pipeline"},
  --  {from: "prd-forge", to: "prd-impl", type: "parent-child"}]
  execution_chains TEXT NOT NULL DEFAULT '[]',

  -- 工作流清单 (JSON)
  -- [{name: "bug-hunter", count: 2, cost: 6.40},
  --  {name: "bug-fixer", count: 1, cost: 3.20}]
  workflow_manifest TEXT NOT NULL DEFAULT '[]',

  -- LLM 总结 (workspace 级别的经验)
  summary         TEXT
);

CREATE INDEX idx_ws_archive_org ON workspace_archive(org);
CREATE INDEX idx_ws_archive_created ON workspace_archive(archived_at);
```

### 8.4 链条关系：三种场景

**场景 A: 流水线链**
```
workspace "daily-scan-0626":
  bug-hunter → 发现 BUG-001
    → bug-fixer → 修复 BUG-001, 创建 PR #5
      → regression-tester → 验证 PR #5 无回归

链条保留:
  - "PR #5 是哪个 bug-hunter 运行发现的" → 可追溯
  - "从发现 BUG 到修复完成的全链路耗时/成本" → 可统计
  - Agent 理解 "上次扫描→修复→测试的完整效果" → 可决策
```

**场景 B: 父子链**
```
workspace "prd-001":
  prd-forge → 产出 PRD 文档
    → prd-impl → 消费 PRD, 实现代码 ($parent.var_pool.output_dir)
      → prd-impl-e2e → 消费 prd-impl 的输出, 跑 E2E

通过 executions.parent_id 自动检测父子关系。
```

**场景 C: 独立并行**
```
workspace "multi-task":
  bug-hunter (独立) — 扫描 engine 包
  gen-workflow (独立) — 开发新工作流
  mvp-doc (独立) — 生成文档

无链条关系, 但属于同一 workspace, 聚合统计总成本。
```

### 8.5 链条自动检测

```
Layer 1: 程序检测 (免费)
  ├── executions.parent_id != '0' → 父子链
  ├── 工作流 inputs 中引用 $parent.var_pool.* → 数据依赖链
  ├── pipeline_state 表中的 chain 配置 → 流水线链
  └── 同一 workspace 内按 started_at 排序 → 时序链

Layer 2: 写入 workspace_archive 时构建
  ArchiveService.archiveWorkspace():
    1. 读取 workspace 内所有 executions
    2. 按 parent_id 构建父子树
    3. 按 started_at 排序构建时序
    4. 写入 workspace_archive.execution_chains
```

### 8.6 与现有表的关系

```
workspace_archive (独立, 聚合层)
  └── execution_archive[] (独立, 不依赖 workspace, 永久保留)
        ↑ 归档来源                    ↑ 经验同步
      executions (随 workspace 删除)   experiences (已有, 全局, FTS 搜索)
        ├── node_executions (删除)     evolution_log (已有, 全局)
        ├── node_token_usages (删除)
        └── execution_summaries (删除)
```

---

## 9. 功能模块详细设计

### Module 1: ArchiveService（执行归档服务）

**文件**: `packages/server/src/services/archive-service.ts`

```typescript
class ArchiveService {
  /**
   * 归档一次执行。在执行完成或 workspace 删除前调用。
   */
  async archiveExecution(
    executionId: string,
    wsArchiveId?: string  // 由 archiveWorkspace 传入，onComplete 调用时为空
  ): Promise<string> {
    // 1. 读取执行数据
    const execution = await execDAO.findById(executionId)
    const nodeResults = await nodeExecDAO.findByExecution(executionId)
    const tokenUsages = await tokenUsageDAO.findByExecution(executionId)

    // 2. 聚合 token/cost (Layer 1: 程序提取)
    const { totalInput, totalOutput, totalCost, modelBreakdown } =
      this.aggregateTokens(tokenUsages)

    // 3. 构建节点摘要
    const nodeSummary = nodeResults.map(n => ({
      nodeId: n.node_id, type: n.node_type,
      status: n.status, duration: n.duration,
    }))

    // 4. 提取关键变量 (Layer 2: 规则过滤)
    const varsSnapshot = this.extractKeyVars(nodeResults)

    // 5. 写入归档表
    const archiveId = generateId()
    await archiveDAO.insert({
      id: archiveId, org: execution.org,
      workflow_ref: execution.workflow_ref,
      workflow_name: execution.workflow_name,
      status: execution.status,
      started_at: execution.started_at,
      completed_at: execution.completed_at,
      duration_ms: execution.duration_ms,
      node_summary: JSON.stringify(nodeSummary),
      failed_nodes: execution.failed_nodes,
      error_message: execution.error_message,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cost_usd: totalCost,
      model_breakdown: JSON.stringify(modelBreakdown),
      vars_snapshot: JSON.stringify(varsSnapshot),
      workspace_archive_id: wsArchiveId || null,
      clone_name: execution.clone_name || null,
    })

    return archiveId
  }

  /**
   * Layer 3: LLM 反思 (haiku, 异步, $0.01/次)
   * 仅在 cost > $1 或 status == failed 时调用
   */
  async extractLessons(archiveId: string): Promise<void> {
    const archive = await archiveDAO.findById(archiveId)

    // 成本门槛: 低成本执行不值得 LLM 反思
    if (archive.total_cost_usd < 1 && archive.status === 'completed') return

    const prompt = this.buildReflectionPrompt(archive)
    const lessons = await llmCall(prompt, 'haiku')

    await archiveDAO.updateLessons(archiveId, lessons)

    // 同步写入 experiences 表, 复用已有 FTS 搜索
    await evolutionDAO.insertExperience({
      skill_name: archive.workflow_name,
      content: lessons,
      org: archive.org,
    })
  }

  /**
   * 批量归档: workspace 删除前自动归档所有未归档的执行
   * 同时构建 workspace_archive 聚合层
   */
  async archiveWorkspace(workspaceId: string): Promise<number> {
    const workspace = await wsDAO.findById(workspaceId)
    const executions = await execDAO.findByWorkspace(workspaceId)

    // 构建链条关系
    const chains = this.detectChains(executions)
    const manifest = this.buildManifest(executions)

    // 创建 workspace_archive
    const wsArchiveId = generateId()
    await wsArchiveDAO.insert({
      id: wsArchiveId, org: workspace.org,
      workspace_name: workspace.name,
      workspace_path: workspace.path,
      created_at: workspace.created_at,
      execution_count: executions.length,
      execution_chains: JSON.stringify(chains),
      workflow_manifest: JSON.stringify(manifest),
    })

    // 归档每个执行, 关联到 workspace_archive
    let count = 0
    for (const exec of executions) {
      if (!exec.archived) {
        const archiveId = await this.archiveExecution(exec.id, wsArchiveId)
        // 写入 Agent daily memory
        const archive = await archiveDAO.findById(archiveId)
        await memoryService.appendToDaily(this.formatMemoryEntry(archive))
        count++
      }
    }

    // 聚合统计
    await wsArchiveDAO.updateStats(wsArchiveId)

    // workspace 级总结 (haiku, 异步, 仅 >= 3 个执行时)
    if (count >= 3) {
      this.generateWorkspaceSummary(wsArchiveId).catch(err => {
        log.warn(`Failed to generate workspace summary: ${err.message}`)
      })
    }

    return count
  }

  private async generateWorkspaceSummary(wsArchiveId: string) {
    const archives = await archiveDAO.findByWorkspaceArchive(wsArchiveId)
    const prompt = `用 3 句话总结以下工作流执行记录:
${archives.map(a => `- ${a.workflow_name}: ${a.status}, $${a.total_cost_usd}, ${a.duration_ms}ms`).join('\n')}`
    const summary = await llmCall(prompt, 'haiku')
    await wsArchiveDAO.update(wsArchiveId, { summary })
  }

  /**
   * 自动检测执行链条关系
   */
  private detectChains(executions: Execution[]): Chain[] {
    const chains: Chain[] = []
    for (const exec of executions) {
      // 父子链: parent_id != '0'
      if (exec.parent_id && exec.parent_id !== '0') {
        chains.push({ from: exec.parent_id, to: exec.id, type: 'parent-child' })
      }
      // 数据依赖链: inputs 引用 $parent.var_pool.*
      if (exec.input_values?.includes?.('$parent')) {
        chains.push({ from: 'parent', to: exec.id, type: 'data-dependency' })
      }
    }
    return chains
  }
}
```

### Module 2: Workspace 删除拦截（两阶段提交）

**修改**: `packages/server/src/services/workspace.ts` — `delete()` 方法

```typescript
async delete(id: string) {
  // Phase 1: 标记为 archiving (前端可展示归档中状态)
  await this.dao.update(id, { archive_status: 'archiving' })

  try {
    // Phase 2: 归档所有执行
    const archiveService = new ArchiveService()
    const archived = await archiveService.archiveWorkspace(id)
    log.info(`Archived ${archived} executions`)

    // Phase 3: 标记归档完成
    await this.dao.update(id, { archive_status: 'archived' })

    // Phase 4: 级联删除 (此时归档已完成且持久化)
    await this.dao.cascadeDeleteByWorkspace(id)
    await fs.promises.rm(workspacePath, { recursive: true, force: true })
  } catch (err) {
    // 归档失败 → 保留 workspace, 不删除, 标记失败
    await this.dao.update(id, { archive_status: 'archive_failed' })
    log.error(`Archive failed for workspace ${id}: ${err.message}`)
    throw new Error('Workspace archiving failed, deletion aborted. Data preserved.')
  }
}
```

新增 workspace 归档状态:

```sql
ALTER TABLE workspaces ADD COLUMN archive_status TEXT DEFAULT 'none';
-- none | archiving | archived | archive_failed
```

**恢复机制**: 定时任务扫描 `archive_status = 'archived'` 但文件仍存在的 workspace，重试文件删除。

### Module 3: Loop Dashboard API

**文件**: `packages/server/src/routes/archive.ts`

```
GET  /archive/stats              — 跨 workspace 的全局统计
GET  /archive/executions         — 归档执行列表 (分页/过滤/排序)
GET  /archive/executions/:id     — 归档执行详情
GET  /archive/cost-trends        — 成本趋势 (按天/周/月)
GET  /archive/workflow-stats     — 按工作流聚合的成功率/耗时/成本
GET  /archive/lessons            — 经验搜索 (FTS)
GET  /archive/leaderboard        — 排行榜 (最省钱/最快/最高成功率)
```

#### `/archive/stats` 响应

```json
{
  "total_executions": 156,
  "completed": 120, "failed": 30, "cancelled": 6,
  "total_cost_usd": 42.50,
  "avg_duration_ms": 1800000,
  "top_workflows": [
    { "name": "bug-hunter", "runs": 45, "success_rate": 0.73, "total_cost": 18.20 },
    { "name": "gen-workflow", "runs": 23, "success_rate": 0.87, "total_cost": 12.10 }
  ],
  "cost_today": 2.30, "cost_7d": 15.80, "cost_30d": 42.50
}
```

> **成本单位**: 存储统一用 USD（REAL 类型）。前端根据用户偏好设置 `currency_preference`（CNY/USD）和汇率（1 USD ≈ 7.2 CNY）转换显示。Dashboard 显示示例: `¥16.8 (≈$2.33)`。

### Module 4: Agent 闭环集成

#### 4.1 编排器增强

**修改**: `packages/server/src/services/agent/orchestrator-service.ts`

```typescript
async classifyAndRoute(message: string): Promise<RouteResult> {
  const intent = await this.classify(message)

  // 查 experience_index — 精确匹配可行动经验
  const experiences = await experienceDAO.search({
    query: message, status: 'active', limit: 5,
  })

  // 查 execution_archive — 仅取最近执行摘要 (不含经验文本)
  const recentRuns = await archiveDAO.findRecent({
    workflow_name: intent.matchedWorkflow,
    limit: 3,
    fields: ['status', 'total_cost_usd', 'created_at', 'vars_snapshot'],
  })

  if (experiences.length > 0) {
    intent.experiences = experiences.map(e => ({
      type: e.type, title: e.title, content: e.content,
    }))
  }
  if (recentRuns.length > 0) {
    intent.recentRuns = recentRuns
  }

  return intent
}
```

**职责分离**:
- `experience_index` → 可行动的经验（注入 Agent prompt，FTS 搜索）
- `execution_archive` → 执行记录统计（Dashboard + "上次跑了什么"）

#### 4.2 执行完成自动触发

```typescript
// packages/server/src/engine/execution-engine.ts
async onComplete(execution: Execution) {
  // 🔥 自动归档
  const archiveService = new ArchiveService()
  const archiveId = await archiveService.archiveExecution(execution.id)

  // 异步提取经验 (不阻塞)
  archiveService.extractLessons(archiveId).catch(err => {
    log.warn(`Failed to extract lessons: ${err.message}`)
  })
}
```

#### 4.3 Agent 自主调度

```typescript
// Agent 发现重复模式, 自注册调度
POST /agent/schedules/register
{
  name: "daily-bug-scan",
  cron: "0 2 * * *",
  timezone: "Asia/Shanghai",
  job_type: "workflow",
  workflow_ref: "bug-hunter",
  input_values: { project_dir: "open-octopus", min_severity: "P2" },
  notify_strategy: { on_success: true, on_failure: true, channel: "telegram:xzf_hermes" }
}
```

### Module 5: Telegram Bot 双向交互

**文件**: `packages/server/src/routes/telegram.ts`

```typescript
app.post('/agent/telegram/webhook', async (c) => {
  const { message } = await c.req.json()

  const response = await agentService.processMessage({
    session_id: `telegram-${message.chat.id}`,
    message: message.text,
    source: 'telegram',
  })

  await hermes.send({
    target: `telegram:${message.chat.id}`,
    message: response.text,
  })
})
```

**Hermes provider 层增加动态路由**（不修改 Hermes CLI 本身）：

```typescript
// packages/server/src/providers/hermes.ts
async send(config: NotifyConfig) {
  const target = config.target

  if (target.match(/^telegram:\d+$/)) {
    // 动态 chat ID → 直接调用 Telegram Bot API
    const chatId = target.split(':')[1]
    await telegramBotAPI.sendMessage(chatId, config.message)
  } else {
    // 命名 target (如 "telegram:xzf_hermes") → 走 Hermes CLI
    await hermesCLI.send(target, config.message)
  }
}
```

Hermes 从"通知工具"升级为"通信桥梁"——支持动态 chat ID 路由 + 命名 target 两种模式。

### Module 6: Agent 记忆/技能/分身系统整合

#### 6.1 现状：四套独立系统

```
系统 1: Agent 记忆 (文件系统 ~/.octopus/agent/memory/)
  ├── daily/2026-06-26.md    ← 对话级记忆
  ├── long-term.md            ← 压缩后的长期记忆
  └── daily/archive/          ← 归档

系统 2: 技能进化 (文件 + DB)
  ~/.octopus/agent/skills/*/SKILL.md + .bak
  DB: evolution_log + experiences

系统 3: 分身系统 (DB)
  DB: clones 表, 每个 clone 有独立 memory scope

系统 4: 执行记忆 (本设计新增)
  DB: execution_archive + workspace_archive + FTS
```

**问题**：四套系统互不知道对方的存在。执行记忆归档了但不进 Agent 记忆，Agent 记住了但不知道执行的 token 消耗，分身合并时不包含执行经验。

#### 6.2 整合方案：数据流

```
                    execution_archive (原始数据)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
      Agent 记忆      experiences   技能进化
      (文件系统)      (DB/FTS)     (SKILL.md)
            │            │            │
            ▼            ▼            ▼
      对话时召回     搜索时命中    执行时加载
```

#### 6.3 整合点 1：执行记忆 → Agent 每日记忆

执行归档后自动向 Agent 的 daily memory 写入摘要：

```typescript
// archive-service.ts
async archiveExecution(executionId: string) {
  // ... 归档逻辑 ...

  // 写入 Agent daily memory
  const memoryEntry = this.formatMemoryEntry(archive)
  await memoryService.appendToDaily(memoryEntry)
}

private formatMemoryEntry(archive: Archive): string {
  return `## 执行记录: ${archive.workflow_name}
- 状态: ${archive.status} | 耗时: ${formatDuration(archive.duration_ms)} | 成本: $${archive.total_cost_usd}
- 关键结果: ${archive.vars_snapshot.conclusion || '无'}
${archive.lessons_learned ? `- 经验: ${archive.lessons_learned}` : ''}`
}
```

效果：Agent 的 daily memory 自动包含当天所有执行记录摘要。当 Agent 被问"今天做了什么"时能回答。

#### 6.4 整合点 2：执行记忆 → 长期记忆压缩

Agent 已有的 `session-compress-service` 每 7 天压缩 daily memory → long-term.md。执行记忆作为 daily memory 的一部分，自然被压缩进长期记忆：

```
daily/2026-06-26.md 包含:
  - 用户对话: "帮我扫描 engine 包"
  - 执行记录: bug-hunter 发现 P1 BUG, $3.20
  - 执行记录: bug-fixer 修复成功, 创建 PR #5
        │
        ▼ (7天压缩)
long-term.md 新增:
  "engine 包在 6 月 26 日发现并修复了 agent.ts 的 return→continue BUG,
   从发现到修复全链路耗时 2.5 小时, 总成本 $6.40。
   经验: swarm 节点的 host 输出必须兼容 vars_update 协议。"
```

#### 6.5 整合点 3：执行经验 → 技能进化

当某个工作流反复产生类似的经验，触发技能进化：

```typescript
// evolution-service.ts — 已有 reflect() 方法
async reflect(): Promise<EvolutionSuggestion[]> {
  // 现有: 分析 daily memory 中的重复模式

  // 新增: 分析 execution_archive 中的重复模式
  const recentArchives = await archiveDAO.findRecent({ days: 7 })
  const patterns = this.detectPatterns(recentArchives)

  // 例: bug-hunter 连续 5 次都在 scan 节点失败
  // → 建议进化 octo-bug-investigation 技能
  //   增加 "swarm vars_update 兼容性检查" 步骤
}
```

#### 6.6 整合点 4：分身 → 执行记忆隔离

分身系统感知执行记忆的归属：

```typescript
// clone 创建时 — memory_scope 支持 execution 过滤
{
  name: "bug-hunter-clone",
  memory_scope: ["execution:bug-hunter"],  // 只读 bug-hunter 的执行记忆
}

// clone 合并时 — 执行经验合并到主 Agent
async mergeClone(cloneName: string) {
  // 现有: 合并记忆文件

  // 新增: 合并执行经验到主 Agent 的 experiences
  const cloneArchives = await archiveDAO.findByClone(cloneName)
  for (const archive of cloneArchives) {
    if (archive.lessons_learned) {
      await evolutionDAO.insertExperience({
        skill_name: archive.workflow_name,
        content: `[from clone:${cloneName}] ${archive.lessons_learned}`,
        org: archive.org,
      })
    }
  }
}
```

#### 6.7 整合后的完整数据流

```
用户: "扫描 engine 包的 BUG" (Telegram)
  │
  ▼
Agent Orchestrator
  ├── 查询 execution_archive → "上次发现 P1, $3.20"
  ├── 查询 Agent memory → "上次 engine 扫描的上下文"
  ├── 查询 experiences FTS → "swarm vars_update 兼容性经验"
  └── 加载 skills → octo-bug-investigation (进化版)
  │
  ▼
创建 workspace + 执行 bug-hunter
  │
  ▼
执行完成 → ArchiveService
  ├── 写入 execution_archive (永久)
  ├── 写入 workspace_archive (聚合)
  ├── 写入 Agent daily memory (对话级)
  ├── haiku 提取 lessons_learned
  └── 写入 experiences (FTS 可搜索)
  │
  ▼
7 天后 → session-compress
  ├── daily memory → long-term.md (压缩)
  └── 执行记录自然融入长期记忆
  │
  ▼
30 天后 → evolution reflect
  ├── 分析执行模式
  └── 建议技能进化 (如: 增加检查步骤)
  │
  ▼
下次执行时 → Agent 带着进化后的技能 + 长期记忆 + 执行经验
  → 更好的决策 → 更好的结果 → 更好的经验 → Loop
```

#### 6.8 整合总结

| Agent 系统 | 整合方式 | 数据流向 |
|-----------|---------|---------|
| **每日记忆** | 执行归档后自动写入 daily memory | archive → daily/*.md |
| **长期记忆** | 通过 session-compress 自然压缩 | daily → long-term.md |
| **技能进化** | reflect() 分析执行模式, 触发进化 | archive → SKILL.md |
| **经验搜索** | lessons_learned 同步到 experiences FTS | archive → experiences 表 |
| **分身系统** | memory_scope 过滤执行记忆, merge 时合并 | archive ↔ clones |
| **编排器** | 分类时注入执行记忆上下文 | archive → orchestrator |

### Module 7: Experience Injection（执行时经验注入）

#### 7.1 经验的三种产出形态

```
执行完成 → ArchiveService 提取经验
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  Agent     Skill     Experience
  记忆      进化      Index + 知识库
  (对话时   (检测到   (工作流执行时
   召回)    重复模式   引擎自动注入
            触发进化)  agent prompt)
```

| 形态 | 载体 | 触发方式 | 作用时机 |
|------|------|---------|---------|
| Agent 记忆 | daily/*.md + long-term.md | 归档时自动写入 | Agent 对话时召回 |
| Skill 进化 | SKILL.md (本地进化版) | reflect() 检测重复模式 | Agent 执行时加载 |
| Experience Index | DB 表 + FTS | haiku 拆分结构化条目 | **引擎注入 agent prompt** |
| 知识库文件 | ~/.octopus/knowledge/{project}/*.md | 归档时追加 | 工作流 YAML 引用 |

#### 7.2 经验的价值矩阵

| 经验类型 | 具体价值 | 举例 |
|---------|---------|------|
| **BUG 模式** | 下次扫描同一文件时聚焦已知高危点 | "agent.ts 的 applyOutputsMapping 有 return/continue 问题" → 下次直接检查所有 executor 循环控制流 |
| **修复模式** | 修复同类 BUG 时避免踩坑 | "swarm host 的 vars_update 不兼容" → 下次写 swarm 工作流时自动检查 |
| **成本数据** | 选择最优参数 | "scan 用 5 专家 opus 花 $6, 3 专家 sonnet 花 $2 效果一样" → 自动降级 |
| **失败模式** | 避免重复犯错 | "condition target 没 depends_on 会 Level 0 执行" → 自动加依赖 |
| **项目知识** | 积累项目特有上下文 | "shared 包改类型后必须先 build shared" → 自动调整构建顺序 |

#### 7.3 核心问题：新 workspace 执行时经验怎么流入？

```
新 workspace 创建 (空白环境)
  ↓
执行 bug-hunter (针对 projects/open-octopus)
  ↓
Agent 节点跑起来时, 它怎么知道:
  - 上次在 engine 包发现了什么 BUG?
  - 哪些文件是高危的?
  - 上次花了多少钱, 什么参数最优?
```

#### 7.4 方案：引擎级 Experience Injection

工作流 YAML 中 agent 节点声明 `experience_scope`：

```yaml
- id: scan
  type: agent
  experience_scope:
    projects: ["$inputs.project_dir"]     # 匹配哪个项目
    packages: ["$inputs.scan_scope"]       # 匹配哪个包
    types: ["bug", "pattern", "cost"]     # 加载哪些类型的经验
    limit: 10                             # 最多注入 10 条
  prompt: |
    扫描代码中的 BUG...
```

引擎在发送 prompt 给 LLM 之前，自动查询 experience_index 并注入：

```
工作流启动
  ↓
引擎解析 experience_scope (变量替换: $inputs.project_dir → "open-octopus")
  ↓
查询 experience_index:
  SELECT * FROM experience_index
  WHERE project IN ('open-octopus')
    AND (package IN ('engine', 'server') OR package IS NULL)
    AND type IN ('bug', 'pattern', 'cost')
    AND status = 'active'
  ORDER BY relevance_score DESC, use_count DESC
  LIMIT 10
  ↓
构建 experience context (注入到 prompt 前面):

  "📚 历史执行经验 (项目: open-octopus):
   
   🐛 BUG-001: executor applyOutputsMapping return→continue
     文件: packages/engine/src/executors/*.ts
     建议: 检查所有 executor 的循环控制流
   
   🐛 BUG-002: swarm host vars_update 不兼容
     建议: 所有 swarm host prompt 必须包含 vars_update
   
   🔧 PATTERN: shared 包构建顺序
     修改 shared/ 后必须 pnpm build -w shared 再全量构建
   
   💰 COST: scan 节点优化
     5 专家 opus = $6 | 3 专家 sonnet = $2, 建议降级"
  ↓
Agent 收到: experience context + 原始 prompt
  ↓
Agent 带着历史知识执行 → 更好的决策
```

Agent 读到经验后：
- 优先检查 `executors/*.ts` 循环控制流（上次在这里发现 BUG）
- 检查 swarm 工作流的 host prompt 格式
- 知道 sonnet 够用，可以建议降级节省成本

#### 7.5 多项目 workspace 精确匹配

`projects/` 下有 N 个 git 项目时：

```yaml
# 单项目场景
experience_scope:
  projects: ["$inputs.project_dir"]   # 只加载 open-octopus 的经验

# 多项目场景
experience_scope:
  projects: ["$inputs.target_projects"]  # 加载多个项目的经验

# 全量场景 (不限项目)
experience_scope:
  types: ["bug"]
  limit: 5
```

#### 7.6 Experience Index 数据表

```sql
CREATE TABLE experience_index (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  org             TEXT NOT NULL DEFAULT '',

  -- 经验来源
  archive_id      TEXT,                   -- 关联的 execution_archive
  workflow_name   TEXT NOT NULL,

  -- 经验内容
  type            TEXT NOT NULL,           -- bug / pattern / cost / failure
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT DEFAULT 'active',   -- active / resolved / obsolete / superseded

  -- 生命周期
  resolved_at     TEXT,                    -- 标记为 resolved 的时间
  resolved_by     TEXT,                    -- PR URL 或手动标记来源

  -- 精确匹配维度
  project         TEXT,                    -- 适用的项目 (open-octopus)
  package         TEXT,                    -- 适用的包 (engine)
  file_pattern    TEXT,                    -- 适用的文件模式 (executors/*.ts)
  keywords        TEXT,                    -- 关键词 (JSON array)

  -- 排序
  relevance_score REAL DEFAULT 1.0,
  use_count       INTEGER DEFAULT 0,       -- 被引用次数 (越用越优先)

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_exp_project ON experience_index(project);
CREATE INDEX idx_exp_package ON experience_index(package);
CREATE INDEX idx_exp_type ON experience_index(type);
CREATE INDEX idx_exp_relevance ON experience_index(relevance_score DESC);

CREATE VIRTUAL TABLE experience_index_fts USING fts5(
  title, content, keywords,
  content='experience_index',
  content_rowid='rowid'
);
```

#### 7.7 ArchiveService 写入 Experience Index

```typescript
// archive-service.ts
async extractLessons(archiveId: string) {
  const archive = await archiveDAO.findById(archiveId)

  // 成本门槛
  if (archive.total_cost_usd < 1 && archive.status === 'completed') return

  // haiku 提取经验 (结构化 + 非结构化一次完成)
  const prompt = `从以下执行结果中提取经验条目:
    工作流: ${archive.workflow_name}
    状态: ${archive.status}
    项目: ${archive.vars_snapshot.project_dir}
    节点摘要: ${archive.node_summary}
    失败节点: ${archive.failed_nodes}
    
    输出 JSON:
    {
      "lessons": "整体经验总结 (非结构化)",
      "items": [
        {
          "type": "bug|pattern|cost|failure",
          "title": "简短标题",
          "content": "详细内容 + 建议动作",
          "project": "适用的项目名或null",
          "package": "适用的包名或null",
          "file_pattern": "适用的文件模式或null",
          "keywords": ["关键词1", "关键词2"]
        }
      ]
    }`

  const result = await llmCall(prompt, 'haiku')

  // 写入 lessons_learned
  await archiveDAO.updateLessons(archiveId, result.lessons)

  // 拆分为索引条目
  for (const item of result.items) {
    await experienceDAO.insert({
      ...item,
      archive_id: archiveId,
      workflow_name: archive.workflow_name,
      org: archive.org,
    })
  }

  // 同步到 experiences 表 (复用 FTS)
  await evolutionDAO.insertExperience({
    skill_name: archive.workflow_name,
    content: result.lessons,
    org: archive.org,
  })

  // 追加到知识库文件
  await this.updateKnowledgeFiles(archive, result.items)
}

/**
 * 重写 ~/.octopus/knowledge/{project}/*.md 文件 (覆盖写, 非追加)
 * 每次从 experience_index 全量重建, 已 resolved/obsolete 的条目自动消失
 */
private async updateKnowledgeFiles(archive, items) {
  const project = archive.vars_snapshot.project_dir
  if (!project) return

  const knowledgeDir = path.join(
    os.homedir(), '.octopus', 'orgs', archive.org, 'knowledge', project
  )
  await fs.mkdir(knowledgeDir, { recursive: true })

  // 从 DB 查询当前所有活跃条目 (包含本次新增的)
  for (const type of ['bug', 'pattern', 'cost', 'failure']) {
    const activeItems = await experienceDAO.query({
      project, type, status: 'active',
      orderBy: 'relevance_score DESC',
    })

    // 大小上限: 超过 50 条时按 relevance 裁剪
    const capped = activeItems.slice(0, 50)

    const content = this.renderKnowledgeMarkdown(type, capped, project)
    const filepath = path.join(knowledgeDir, `${type}s.md`)
    await fs.writeFile(filepath, content)  // 覆盖写, 不是追加
  }
}
```

#### 7.8 知识库文件结构

```
~/.octopus/orgs/{org}/knowledge/
├── open-octopus/
│   ├── bugs.md           ← BUG 经验索引
│   ├── patterns.md       ← 修复模式索引
│   └── costs.md          ← 成本基准索引
├── other-project/
│   └── ...
```

**bugs.md 示例**:

```markdown
# BUG 经验 — open-octopus

## BUG-001: executor applyOutputsMapping return→continue
- 文件: packages/engine/src/executors/*.ts
- 模式: for...of 循环内使用 return 而非 continue
- 修复: return → continue
- 来源: bug-hunter 2026-06-26 | PR #2
- 状态: ✅ 已修复
- 检查建议: 扫描所有 executor 的循环控制流

## BUG-002: swarm host vars_update 不兼容
- 文件: 任何 swarm 工作流 YAML
- 模式: host prompt 未输出 vars_update JSON
- 修复: 引擎补丁 + host prompt 加 vars_update
- 来源: bug-hunter 2026-06-26
- 状态: ✅ 已修复
- 检查建议: 所有 swarm host prompt 必须包含 vars_update + assessment
```

#### 7.9 引擎注入实现

```typescript
// packages/engine/src/engine.ts — 修改 agent 节点执行逻辑
private async injectExperience(
  node: NodeDef,
  pool: VarPool
): Promise<string> {
  if (!node.experience_scope) return ''

  // 变量替换
  const scope = this.resolveScope(node.experience_scope, pool)

  // 查询 experience_index
  const items = await experienceDAO.query({
    projects: scope.projects,
    packages: scope.packages,
    types: scope.types,
    limit: scope.limit || 10,
  })

  if (items.length === 0) return ''

  // 更新 use_count
  await experienceDAO.incrementUseCount(items.map(i => i.id))

  // 构建 context
  return this.formatExperienceContext(items, scope)
}

private formatExperienceContext(items, scope): string {
  const grouped = { bug: [], pattern: [], cost: [], failure: [] }
  for (const item of items) grouped[item.type]?.push(item)

  let ctx = `📚 历史执行经验 (项目: ${scope.projects?.join(', ') || '全局'}):\n\n`

  if (grouped.bug.length) {
    ctx += '🐛 BUG 模式:\n'
    for (const b of grouped.bug) {
      ctx += `- ${b.title}\n  ${b.content}\n`
    }
    ctx += '\n'
  }
  if (grouped.pattern.length) {
    ctx += '🔧 修复模式:\n'
    for (const p of grouped.pattern) {
      ctx += `- ${p.title}\n  ${p.content}\n`
    }
    ctx += '\n'
  }
  if (grouped.cost.length) {
    ctx += '💰 成本基准:\n'
    for (const c of grouped.cost) {
      ctx += `- ${c.title}\n  ${c.content}\n`
    }
    ctx += '\n'
  }

  return ctx + '---\n\n'
}
```

### Module 8: ExperienceLifecycleService（经验生命周期管理）

#### 8.1 问题

experience_index 的 status 字段（active/resolved/obsolete/superseded）没有更新机制。BUG 修复后经验仍为 active，Agent 被过时信息淹没。

#### 8.2 三个触发点

```typescript
class ExperienceLifecycleService {
  /**
   * 触发点 1: PR 合并时标记 resolved
   * 由 GitHub webhook → Octopus Server 触发
   */
  async markResolved(prUrl: string): Promise<number> {
    // 从 PR 描述中提取 BUG 标识
    const prBody = await githubAPI.getPR(prUrl)
    const bugRefs = this.extractBugRefs(prBody)  // ["BUG-001", "BUG-002"]

    let count = 0
    for (const ref of bugRefs) {
      const result = await experienceDAO.updateByKeyword({
        keyword: ref,
        updates: {
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: prUrl,
        },
      })
      count += result.changes
    }
    return count
  }

  /**
   * 触发点 2: 定期衰减过期经验
   * 由 Scheduler 内置 job 触发 (每周一次)
   */
  async decayStale(): Promise<number> {
    // use_count=0 且创建超过 90 天 → obsolete
    return await experienceDAO.bulkUpdate({
      where: {
        use_count: 0,
        created_before: daysAgo(90),
        status: 'active',
      },
      updates: { status: 'obsolete' },
    })
  }

  /**
   * 触发点 3: 新经验替代旧经验
   * 在 extractLessons() 写入新条目后调用
   */
  async supersede(newItem: ExperienceItem): Promise<void> {
    if (!newItem.file_pattern) return

    // 同 project + 同 file_pattern + 同 type 的旧条目 → superseded
    await experienceDAO.bulkUpdate({
      where: {
        project: newItem.project,
        file_pattern: newItem.file_pattern,
        type: newItem.type,
        status: 'active',
        exclude_id: newItem.id,
      },
      updates: { status: 'superseded' },
    })
  }
}
```

#### 8.3 注入时过滤

引擎注入经验时只查 active 状态（§7.9 的 SQL 已包含 `AND status = 'active'`），resolved/obsolete/superseded 的条目不会被注入 Agent prompt，但仍可通过 Dashboard 搜索查看。

### Module 9: ChainTriggerService（链条工作流自动触发）

#### 9.1 问题

§8.4 描述了 `bug-hunter → bug-fixer → regression-tester` 流水线链，但只有归档记录，没有自动触发机制。§7.1 场景说"Agent 读取归档数据 → 自动触发 bug-fixer"，但没有定义触发入口。

#### 9.2 方案：工作流 YAML 声明后继 + 引擎自动触发

```yaml
# 工作流 YAML 新增 chain 字段
# bug-hunter.yaml
name: bug-hunter
chain:
  on_success:
    - workflow: bug-fixer
      condition: '$vars.confirmed == "true"'
      auto_trigger: true
      input_mapping:
        bug_reports: '$vars.bug_report_dir'
        base_branch: '$inputs.base_branch'
  on_failure: []
```

```typescript
// execution-engine.ts onComplete 中增加链条触发
async onComplete(execution: Execution) {
  // ... 归档 + 经验提取 ...

  // 链条触发
  const chainConfig = execution.workflow.chain
  if (chainConfig?.on_success && execution.status === 'completed') {
    for (const next of chainConfig.on_success) {
      if (next.auto_trigger && evaluateCondition(next.condition, pool)) {
        const mappedInputs = resolveInputMapping(next.input_mapping, pool)
        await this.trigger({
          workspace_id: execution.workspace_id,  // 同一 workspace
          workflow_ref: next.workflow,
          parent_id: execution.id,               // 建立父子链
          input_values: mappedInputs,
        })
        log.info(`Chain triggered: ${next.workflow} (parent: ${execution.id})`)
      }
    }
  }
}
```

#### 9.3 效果

```
bug-hunter 完成 → onComplete 检测 chain.on_success
  → condition '$vars.confirmed == "true"' 为 true
  → 自动触发 bug-fixer (同一 workspace, parent_id 建立父子链)
  → bug-fixer 完成 → 自动触发 regression-tester
  → 全部完成 → archiveWorkspace 时链条关系自动检测并记录
```

---

## 10. 前端改动

### Dashboard 新增 "执行记忆" 标签页

```
┌─────────────────────────────────────────────────┐
│  Dashboard                                      │
│  [概览] [队列] [最近] [健康度] [执行记忆]        │
│                                                 │
│  ┌─── 成本趋势 (7天) ───────────────────────┐   │
│  │  📈 ~~~~ 折线图 ~~~~                     │   │
│  │  今日: ¥16.8 | 本周: ¥112 | 本月: ¥302  │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─── 工作流排行 ──────────────────────────┐    │
│  │ 🥇 bug-hunter    45次 73% ¥128         │    │
│  │ 🥈 gen-workflow  23次 87% ¥85          │    │
│  │ 🥉 prd-forge     12次 92% ¥45          │    │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─── 最近经验 ────────────────────────────┐    │
│  │ 📝 bug-hunter: return→continue 一行修复  │    │
│  │ 📝 gen-workflow: loop+condition 更可靠   │    │
│  │ 📝 bug-hunter: 路径穿越漏洞修复经验       │    │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 11. 实现路线

| Phase | 内容 | 核心产出 | 优先级 |
|-------|------|---------|--------|
| **Phase 1** | 执行归档 | execution_archive + workspace_archive 表 (INTEGER PK) + ArchiveService + 两阶段删除 | 🔴 最高 |
| **Phase 2** | Experience Index | experience_index 表 (含生命周期字段) + haiku 拆分 + 知识库重写模式 | 🔴 最高 |
| **Phase 3** | 引擎注入 | experience_scope 字段 + injectExperience() + clone_name 支持 | 🔴 最高 |
| **Phase 4** | 经验生命周期 | ExperienceLifecycleService (PR 合并标记 resolved + 定期衰减 + 新旧替代) | 🔴 最高 |
| **Phase 5** | 链条触发 | 工作流 YAML chain 字段 + ChainTriggerService (onComplete 自动触发后继) | 🟡 高 |
| **Phase 6** | Loop Dashboard | /archive/* API + 前端标签页 + 成本趋势 (USD 存储 + 前端汇率转换) | 🟡 高 |
| **Phase 7** | Agent 记忆整合 | 执行归档 → daily memory + experiences 同步 + session-compress 联动 | 🟡 高 |
| **Phase 8** | Agent 闭环 | 编排器查 experience_index + 技能进化联动 + Hermes 动态路由 | 🟡 高 |
| **Phase 9** | Telegram 双向 | Telegram Bot webhook + 指令集 + Hermes provider chat ID 路由 | 🟢 中 |
| **Phase 10** | 自主 Loop | Observe 三种触发 + Agent 自注册调度 + 模式识别 + 分身整合 | 🟢 中 |

### Phase 1 详细清单

1. `packages/server/src/db/schema.sql` — 新增 execution_archive + workspace_archive 表 (INTEGER PK + TEXT UUID)
2. `packages/server/src/db/dao/archive-dao.ts` — 新建 ArchiveDAO
3. `packages/server/src/db/dao/workspace-archive-dao.ts` — 新建 WorkspaceArchiveDAO
4. `packages/server/src/services/archive-service.ts` — 新建 ArchiveService (含链条检测 + clone_name + wsArchiveId 参数)
5. `packages/server/src/services/workspace.ts` — 修改 delete() 为两阶段提交 (archiving → archived → cascade)
6. `packages/server/src/engine/execution-engine.ts` — 修改 onComplete 自动归档

### Phase 2 详细清单

7. `packages/server/src/db/schema.sql` — 新增 experience_index 表 (含 resolved_at/resolved_by)
8. `packages/server/src/db/dao/experience-dao.ts` — 新建 ExperienceDAO
9. `packages/server/src/services/archive-service.ts` — extractLessons() haiku 拆分 + 写入 index + 知识库重写模式

### Phase 3 详细清单

10. `packages/shared/src/types/workflow.ts` — NodeSchema 增加 experience_scope 字段
11. `packages/core-pack/presets/workflows/doc/workflow-schema.json` — schema 增加 experience_scope + chain
12. `packages/engine/src/engine.ts` — 新增 injectExperience() 方法, agent 节点执行前调用

### Phase 4 详细清单

13. `packages/server/src/services/experience-lifecycle-service.ts` — 新建 ExperienceLifecycleService
14. `packages/server/src/routes/webhooks/github.ts` — PR 合并 webhook → markResolved()
15. Scheduler 内置 job `experience-decay` — 每周执行 decayStale()

### Phase 5 详细清单

16. `packages/shared/src/types/workflow.ts` — WorkflowSchema 增加 chain 字段
17. `packages/engine/src/engine.ts` — onComplete 增加链条触发逻辑

---

## 12. 与 Loop Engineering 的对齐

| Loop 构建模块 | 本设计如何补全 |
|---------------|---------------|
| **Memory/State** | execution_archive + workspace_archive + experience_index = 三层执行记忆; 生命周期管理 (resolved/obsolete/superseded); Agent daily memory 自动融入; 知识库文件重写模式保持精简 |
| Automations | Scheduler 自动创建 workspace + 执行 + 归档 + 清理; Agent 自注册调度; **chain 字段自动触发后继工作流** |
| Skills | 经验 → reflect() 触发技能进化; experience_scope 让工作流执行时自动加载历史知识; 过期经验自动衰减避免噪音 |
| Connectors | Telegram Bot 双向交互; Hermes provider 支持动态 chat ID 路由 + 命名 target |
| Sub-agents | 编排器查 experience_index 做决策; 分身系统通过 clone_name 隔离执行记忆; agent 节点通过 experience_scope 注入项目级经验 |

> **核心转变**: 从 "执行→遗忘→冷启动" 到 "执行→归档→经验索引→生命周期管理→引擎注入→带记忆执行→更好的结果→更好的经验→Loop"
