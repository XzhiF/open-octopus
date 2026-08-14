# 01 — Shared Schema: Budget 字段 + DB Migration

## What to build
在 `@octopus/shared` 的 workflow Zod schema 中新增顶层 `budget` 可选字段，在 `@octopus/server` 的 DB schema 中为 `executions` 表新增 `budget_snapshot` 列。

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [ ] AC-1: `WorkflowSchema` 包含 `budget: BudgetSchema` 可选字段
- [ ] AC-2: `BudgetSchema` 定义 `max_tokens` (int positive) / `max_duration` (int positive, 秒) / `max_cost_usd` (number positive) / `alert_threshold` (number 0-1, default 0.8)，全部 optional
- [ ] AC-3: `schema.sql` 中 `executions` 表包含 `budget_snapshot TEXT DEFAULT NULL` 列
- [ ] AC-4: `octopus workflow validate` 对含非法 budget（如 `max_tokens: "abc"`）的 YAML 返回非零退出码和明确错误信息

## Verification Method
**Verification type**: Integration test

**Verification steps**:
```bash
# 1. 构建 shared 包
pnpm --filter @octopus/shared build

# 2. 验证合法 budget YAML
cat > /tmp/test-budget.yaml << 'EOF'
name: test
budget:
  max_tokens: 100000
  max_duration: 300
  max_cost_usd: 2.0
  alert_threshold: 0.9
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
node -e "const {parseWorkflow} = require('./packages/shared/dist'); console.log(JSON.stringify(parseWorkflow(require('fs').readFileSync('/tmp/test-budget.yaml','utf8')).budget))"
# 期望: {"max_tokens":100000,"max_duration":300,"max_cost_usd":2,"alert_threshold":0.9}

# 3. 验证非法 budget YAML
cat > /tmp/test-bad-budget.yaml << 'EOF'
name: test
budget:
  max_tokens: "abc"
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
node -e "const {parseWorkflow} = require('./packages/shared/dist'); try { parseWorkflow(require('fs').readFileSync('/tmp/test-bad-budget.yaml','utf8')); process.exit(0) } catch(e) { console.error(e.message); process.exit(1) }"
# 期望: 退出码 1，输出包含 "budget" 和 "max_tokens"

# 4. 验证 budget 可选（无 budget 的 YAML 仍通过）
cat > /tmp/test-no-budget.yaml << 'EOF'
name: test
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
node -e "const {parseWorkflow} = require('./packages/shared/dist'); parseWorkflow(require('fs').readFileSync('/tmp/test-no-budget.yaml','utf8')); console.log('OK')"
# 期望: OK

# 5. DB migration 验证
pnpm --filter @octopus/server build
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec(require('fs').readFileSync('./packages/server/src/db/schema.sql','utf8')); const cols = db.pragma('table_info(executions)'); console.log(cols.find(c => c.name === 'budget_snapshot') ? 'OK' : 'FAIL')"
# 期望: OK
```

**Pass criteria**: 所有 5 个验证步骤通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
