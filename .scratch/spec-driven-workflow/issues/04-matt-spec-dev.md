# 04 — matt-spec-dev 规格直执行流

Status: done

## What
`core-pack/workflows/matt-spec-dev.yaml`（spec-resolve bash 定位「最大 spec-rN 否则 spec.md」+ issues 核对 + 反馈探测 + branch → fail-fast → spec-review(仅反馈轮，ws 就地改 spec.md + K8 行稳定 + round-report「Spec 修订」节) → ticket-dag(普通票 implement+tdd / NN-e2e-* 票 matt-e2e-test-methodology+e2e-harness 反假跑) → integration-gate → code-review → integration-verify → ship-pr → hermes 通知）+ `matt-spec-dev.test.yaml` 3 场景；`${phase.batch_rel}` 词表（template-resolver + gateV4Phases + 快照/测试）；task-fix.yaml 头注释/输入描述/纪律 3 小改反转口径。

## Verification Method
- `octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml`（3/3）
- `npx vitest run tasks-v4-gate` batch_rel 正/反用例
- 安装注记：新流需 `octopus setup`（写入 ADR/SKILL/提交说明）
