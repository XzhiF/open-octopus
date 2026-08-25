# 06 — task-author SKILL.md HOW-handoff

## What to build
`packages/core-pack/skills/task-author/SKILL.md` 升级（v2.1.0）：
- frontmatter: description / tags 加 `workflow_ref` + `how-handoff`；version → 2.1.0
- §WHAT/HOW 区分：明确 authoring agent 负责 HOW 选择（ADR-0013 §1.4）
- spec-field 表新增 `workflow_ref` 行（含 fail-fast 提示）
- 端点 5：`GET /:id/workflow-ref`（view 绑定）
- §HOW-handoff 完整流程：
  - 步骤 1：`GET /api/workflows/built-in` 枚举
  - 步骤 2：推荐 + 用户确认（**禁止擅自绑定**）
  - 步骤 3a：接受 → 绑定 builtin ref（`PATCH /tasks/:id/spec-field workflow_ref=group/name`）
  - 步骤 3b：拒绝 → 自建（validate + 模拟器硬门槛 + decisions 声明副作用）→ 写入 `{home}/workflows/*.yaml` → 绑定 filename ref
  - 步骤 4：`GET /:id/workflow-ref` 检查绑定
- 错误码表：400 workflow not resolvable / 404 task not found / 409 workflow_ref unresolvable
- 交互风格：强调"推荐但不擅自绑定"

## Blocked by
None（纯文档，但依赖 01-05 的后端能力实际可用）

## Status
done

## Acceptance Criteria
- [x] AC1: agent 枚举已安装 flow + 推荐 + 用户确认（**手动清单** — skill 指令已写明）
- [x] AC2: 用户拒绝 → 自建流程（skill §步骤 3b 已写明）
- [x] AC5: validate + 模拟器硬门槛（skill 已写）
- [x] AC6: decisions 字段声明副作用（skill §步骤 3b 已写）

## Verification Method
- `grep -c "workflow_ref" packages/core-pack/skills/task-author/SKILL.md` ≥ 5
- `grep "HOW-handoff" packages/core-pack/skills/task-author/SKILL.md` 命中
- 真实 authoring 会话验证（**手动清单**）

## Implementation notes
- 仅 `packages/core-pack/skills/task-author/SKILL.md` 修改
- 无代码改动（纯文档 + agent 流程指令）
