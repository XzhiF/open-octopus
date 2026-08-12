# 07 — CLI Validate + octo-workflow-dev Skill 文档更新

## What to build
1. 确认 `octopus workflow validate` 通过 shared Zod schema 自动校验 budget 字段（01 已加 schema，此处验证端到端）
2. 更新 `octo-workflow-dev` skill 文档，增加 `budget` 字段说明和 YAML 示例

## Blocked by
01-shared-schema-budget

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `octopus workflow validate` 对含合法 budget 的 YAML 返回成功（退出码 0）
- [ ] AC-2: `octopus workflow validate` 对含非法 budget 的 YAML（如 `max_tokens: -1` 或 `max_tokens: "abc"`）返回失败（退出码 != 0）并显示明确的 budget 错误信息
- [ ] AC-3: `octo-workflow-dev` skill 文档包含 `budget` 字段的说明、类型、默认值、示例

## Verification Method
**Verification type**: Integration test + Manual checklist

**Verification steps**:
```bash
# 1. 合法 budget 验证
cat > /tmp/valid-budget.yaml << 'EOF'
name: test
budget:
  max_tokens: 100000
  max_duration: 300
  max_cost_usd: 2.0
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
pnpm cli workflow validate /tmp/valid-budget.yaml
# 期望: 退出码 0

# 2. 非法 budget 验证 — 类型错误
cat > /tmp/bad-type.yaml << 'EOF'
name: test
budget:
  max_tokens: "abc"
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
pnpm cli workflow validate /tmp/bad-type.yaml
# 期望: 退出码 != 0, 输出含 "budget" 和 "max_tokens"

# 3. 非法 budget 验证 — 负数
cat > /tmp/bad-negative.yaml << 'EOF'
name: test
budget:
  max_tokens: -1
nodes:
  - id: test
    type: bash
    command: echo hello
EOF
pnpm cli workflow validate /tmp/bad-negative.yaml
# 期望: 退出码 != 0

# 4. Skill 文档检查
grep -r "budget" .claude/skills/octo-workflow-dev/
# 期望: 找到 budget 字段文档
```

**Pass criteria**: 所有 4 个验证步骤通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
