# E2E Test Plan — goal-task-dev (Phase 4 independent verification)

Scope: spec AC1–AC9 + ticket-07 handoffs (1)–(8). Timestamp: 2026-08-29T01:45 local.
Data prefix: E2E_TEST_GTD_. DB: ~/.octopus/db/octopus.db. API :3001 (dev, no auth gate — R6 note), Web :3000.

| AC | Assertion | Mode | Script | Layers (R3) |
|----|-----------|------|--------|-------------|
| AC1 | buildGoalPrompt `/goal` 首行 + 全量注入(>200字 VERBATIM) | Unit | T1-units.sh (engine agent-goal-mode) | unit-prompt |
| AC2 | 真跑收敛: completed + hello.txt + (evidence chain per B) | REAL integration | T5 → scripts/goal-realrun-probe.mjs (A1/A2) | exec↔file↔JSONL |
| AC3 | 真跑不收敛: failed + goal_not_met + numTurns>0 + JSONL active_goal 链 (B4/B5) | REAL integration | T5 → probe (B1-B5) | exec↔JSONL↔file |
| AC4 | sdkOptions 直通 maxTurns/maxBudgetUsd/tools/disallowedTools + resolveNodeNumber | Unit | T1 (providers claude-goal-plumbing + engine) | unit-mapping |
| AC5 | planning 废弃迁移错误 + engine≠claude warnings | Unit + CLI | T1 (shared goal-mode) + T2-cli.sh | unit + CLI-stderr |
| AC6 | presets general-dev=task-dev; superpowers-zh filter; task-dev inputs 契约; bind→ready→confirm→DB 物化(goal/ac 物化, max_turns 缺省不占位, 变体 max_turns="5" 持久化) | API E2E + DB | T3-api.mjs | API↔DB↔file |
| AC7 | simulate task-dev 2 场景 + superpowers 2 场景 | fixture CLI | T2-cli.sh | CLI↔file |
| AC8 | grep yaml-language-server=0; workflow-schema.json 删; sync 分支移除 | Static | T4-ac8.sh | file-grep |
| AC9 | CloneInitService 迁移 3 用例 + live catalog v2 ≡ seed | Unit + live | T1 (server) + T3 (live GET↔file) | unit↔file↔API |
| 07-AC1 | 全链真跑: throwaway repo /tmp/gtd-e2e-repo, develop goal 收敛 + ship 本地 commit + ship-report.md | REAL E2E | T6-fullchain.mjs | API↔DB↔git↔file↔JSONL↔UI |
| 06-fixF/N | Browser: 绑定 dialog preset 预填 + max_turns 显示 "200" (F) + 手动换选清空 (N) + badge | Browser E2E | T7-browser.mjs | UI screenshot↔DB |
| 回归 | pnpm test 全量失败集 vs 基线 | Unit suite | T8-regression | test-set |

Safety: all 19 user schedules stay paused; never bind/run task-dev against octopus repo or any repo with remote; gate-test tasks aborted before scheduler tick (60s), hard-deleted after; ~$1 budget (probe ~$0.4 + fullchain ~$0.5).
