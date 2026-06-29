# 05 — 审核队列

## 1. 统一入口

规则和 Skill 共用一个审核队列。不管来源是 workspace 归档、Agent 对话、还是行为检测，都进入同一个待审核列表。

```typescript
interface PendingItem {
  id: string
  type: 'rule' | 'skill'

  // 来源
  source: 'workspace_archive' | 'agent_conversation' | 'behavior_pattern' | 'scheduler' | 'clone_merge'
  source_ref: string          // workspace ID / session ID / pattern ID
  source_label: string        // "prd-impl 2026-06-23" / "Agent 对话 06-28"

  // 内容
  content: string             // 规则文本 或 Skill Markdown
  target_file: string         // 写入哪个知识文件 或 SKILL 目录
  scope: 'project' | 'workflow' | 'global'

  // 冲突检测
  conflicts?: ConflictInfo[]  // 与已有知识的冲突项

  // 审核
  confidence: number          // 0-1, 越高越建议自动通过
  auto_approve: boolean       // 是否可自动通过（重复踩坑 ≥ 3 次）
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'deferred'
  created_at: string
  reviewed_at?: string
  user_notes?: string
}

interface ConflictInfo {
  existing_rule: string       // 已有规则文本
  existing_file: string       // 已有规则所在文件
  conflict_type: 'contradicts' | 'overlaps' | 'supersedes'
}
```

## 2. 审核策略

### 按来源分级

| 来源 | 默认策略 | 原因 |
|------|---------|------|
| 手动执行 | `auto` — 完成后弹窗审核 | 用户在电脑前 |
| Scheduler 触发 | `background` — 后台积累，批量审核 | 用户可能不在 |
| Agent 对话 | `inline` — 对话中直接提议 | 用户正在交互 |
| 行为模式检测 | `background` — 低置信度，需人工 | 检测结果不确定 |
| 重复踩坑 ≥ 3 次 | `auto_approve` — 自动通过 | 证据充分 |

### Background 模式

```
Scheduler 触发 bug-hunter (凌晨 2 点)
  ↓
执行完成 → extractRules() 后台运行
  ↓
提取的规则进入审核队列 (status: pending)
  ↓
用户下次打开 Dashboard:
  知识 Tab 的 "审核队列" 显示 🔴 3
  → 点击进入批量审核
```

### Auto-approve 模式

```typescript
// 重复踩坑 ≥ 3 次，自动通过
async function processAutoApprovals(): Promise<void> {
  const pending = await pendingDAO.findByStatus('pending')

  for (const item of pending) {
    if (item.auto_approve && item.confidence >= 0.6) {
      await approveItem(item)
      await pendingDAO.update(item.id, {
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        user_notes: 'Auto-approved: recurring pitfall (≥3 occurrences)',
      })
    }
  }
}
```

## 3. 冲突检测

新规则写入前，检测与已有知识的冲突：

```typescript
async function detectConflicts(
  newRule: ProposedRule,
  knowledgeDir: string,
): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = []

  // 读取所有知识文件
  const files = readdir(knowledgeDir).filter(f => f.endsWith('.md') && f !== 'index.md')

  for (const file of files) {
    const content = await readFile(join(knowledgeDir, file), 'utf-8')
    const existingRules = parseRulesFromMarkdown(content)

    for (const existing of existingRules) {
      // 用 LLM 判断是否冲突 (haiku, 批量判断降低成本)
      const conflict = await checkConflict(newRule.text, existing.text)
      if (conflict) {
        conflicts.push({
          existing_rule: existing.text,
          existing_file: file,
          conflict_type: conflict.type,  // contradicts | overlaps | supersedes
        })
      }
    }
  }

  return conflicts
}
```

### 冲突类型处理

| 冲突类型 | 含义 | UI 展示 |
|---------|------|---------|
| `contradicts` | 新规则与已有规则矛盾 | "⚠️ 冲突! 已有: '...' → 新: '...'" |
| `overlaps` | 新规则与已有规则部分重叠 | "ℹ️ 与已有规则重叠，考虑合并" |
| `supersedes` | 新规则完全替代已有规则 | "🔄 替代已有规则" |

## 4. 审核操作

| 操作 | 效果 |
|------|------|
| **✅ 纳入** | 写入目标知识文件 + 更新 index.md |
| **✏️ 编辑** | 打开编辑器，修改后纳入 |
| **🤖 讨论** | 右侧展开 AI 助手，对话式修改 |
| **❌ 拒绝** | 标记 rejected，不写入 |
| **⏸ 暂缓** | 标记 deferred，下次再审核 |
| **批量 ✅** | 全选后一键通过 |

## 5. 存储

审核队列存在 SQLite 中：

```sql
CREATE TABLE pending_review (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- rule | skill
  source TEXT NOT NULL,            -- workspace_archive | agent_conversation | ...
  source_ref TEXT NOT NULL,
  source_label TEXT NOT NULL,
  content TEXT NOT NULL,
  target_file TEXT NOT NULL,
  scope TEXT NOT NULL,
  conflicts TEXT,                  -- JSON array of ConflictInfo
  confidence REAL DEFAULT 0.5,
  auto_approve INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  user_notes TEXT
);

CREATE INDEX idx_pending_status ON pending_review(status);
CREATE INDEX idx_pending_source ON pending_review(source);
```

## 6. 与 Agent 对话的整合

用户可以在 Agent 对话中管理审核队列：

```
用户: "有什么待审核的？"
Agent: "📋 3 条待审核:
        1. 规则: Promise.allSettled 必须设超时 (来自 prd-impl 06-23)
        2. Skill: octopus-actuator-dev (来自 feat-acturator-enahnce)
        3. 规则: scan 节点 Grep 优先 (来自 bug-hunter 06-26)
        要审核哪条？还是全部审核？"

用户: "全部审核"
Agent: "好的，逐条展示:
        [1/3] Promise.allSettled 必须设全局超时
        来源: review blocker B4 | 适用范围: 全局
        [✅ 纳入] [❌ 跳过] [✏️ 修改]"
```
