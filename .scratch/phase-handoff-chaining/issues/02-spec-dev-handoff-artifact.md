# 02 — matt-spec-dev：ship 产 handoff.md + spec-resolve 探测 + 提示词消费

## What to build

`packages/core-pack/workflows/matt-spec-dev.yaml` 三处：

1. **ship-pr 新增产物步**：产/覆写 `$inputs.batch_dir/handoff.md` — 头块（phase 名/slug · 终态轮次 rN · PR 链接 · 批次路径）+ `## Protected Decisions` / `## Confirmed Interfaces` / `## Gap Targets`；纪律=精选短页一屏内、细节引用 round-report.md 不复制、只写 ws（collect 管回流）。
2. **spec-resolve 探测**：inputs 增可选 `prev_handoff_paths`（管理键说明，绑定表单免手填）；bash 逐行探测存在性 → `vars.prev_handoffs`（存在子集）+ `vars.prev_handoff_count`；缺失静默跳过不 fail。**⚠️ R1 第一跳先验证**：bash 节点能否读 home 绝对路径（基线 path-guard 域有红）——不通则按 spec R1 退路（seed 拷入）先停下来向主会话报告，勿擅自动 seed 协议。
3. **消费提示词 ×3**：`spec-review` / `ticket-dag` 普通票模板 / `ship-pr` 各加「先读前序交接：$vars.prev_handoffs（空则无前序）」。

改毕：`octopus setup` 落安装库（sync-builtin 不管 workflows，ADR-0018 §4）。

## Blocked by

None — can start immediately.（键名契约已在 spec/ADR-0019 锁死，与 01 并行安全）

## Status

ready-for-agent

## Acceptance Criteria

- [ ] AC1: simulate 轮后 ws 批次目录存在 handoff.md，含头块 + 三段标题
- [ ] AC2: 同批次重跑轮 → handoff.md 被覆写（非追加），头块轮次更新
- [ ] AC3: 输入含 `prev_handoff_paths`（真实+虚构路径混合）→ `vars.prev_handoffs` 只含存在者、count 正确
- [ ] AC4: 无该输入（v3 式绑定/首 phase）→ spec-resolve 行为与改前一致（回归）
- [ ] AC5: 既有 simulate 3/3 不回归；`octopus setup` 后 installed 副本 = 源

## Verification Method

**Verification type**: simulate（mock LLM 输出）+ 文件断言

**Verification steps**:
```bash
octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml   # 既有 3 场景绿 + 新增 handoff/prev 场景绿
octopus setup && diff <(cat ~/.octopus/resources/installed/workflows/built-in/matt-spec-dev.yaml) packages/core-pack/workflows/matt-spec-dev.yaml
```
新 fixture：批次目录预置 spec+issues+handoff 输入位；断言 vars 与产物文件（mock agent 输出按 simulate 惯例给 vars_update）。

**Pass criteria**: AC1–AC5 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
