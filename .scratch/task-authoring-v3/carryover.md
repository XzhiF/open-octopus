# Carryover — task-authoring-v3

| AC# | Previous Status | Round Found | Round Fixed | Current Status |
|-----|----------------|-------------|-------------|---------------|
| US8 | PARTIAL (manual-only, LLM behavior) | R1 | R2 | **PASS-with-manual-evidence-pending** — checklist M1-M5 + persona/context 机制断言齐备（r2-04，38/38 vitest 绿）；LLM 对话残差 = BLOCKED-pending-human（entry-42 convention 显式例外） |
| D12 | PARTIAL (/tasks/prototype route still shipped) | R1 | R2 | **PASS** — 路由删除、/tasks/prototype → 404、零代码引用（r2-01；R2 audit 核定） |

## Non-AC follow-ups（r2 处置）
- Sibling E2E specs v3 迁移 → CLOSED（11 passed + 2 provider-gated skips，互相镜像容忍）
- pipeline-report 口径 → CLOSED（vs 9917e986 实时核对 + 口径演变脚注）
- dispatch 套件断言 → CLOSED（22→42 expects，零 tautology）
- 31-file 环境漂移基线 → 独立未来任务（loop 外）
- 15 个 provider-gated hung executions（E2E_TD_org）→ 无 LLM 环境固有现象

## 收敛判定记录
R2 audit（80.6/100 REVIEW）：所有自动化可达 gap 已闭环；L5 未达 85 为公式结构性上限（95 files → risk 0.6 + 密度中段，GO 需断言 padding 才可及 — 被反假跑规则禁止）。按 loop no-progress/BLOCKED 规则退出，残差项显式记录于 MANUAL-CHECKLIST.md 与 loop-summary.md。
