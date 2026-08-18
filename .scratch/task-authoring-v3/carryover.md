# Carryover — task-authoring-v3

| AC# | Previous Status | Round Found | Round Fixed | Current Status |
|-----|----------------|-------------|-------------|---------------|
| US8 | PARTIAL (manual-only, LLM behavior) | R1 | — | PARTIAL — P1 gap target r2 (mechanism assertions + MANUAL-CHECKLIST; residual = human-run evidence) |
| D12 | PARTIAL (/tasks/prototype route still shipped) | R1 | — | PARTIAL — P1 gap target r2 (remove route per R6 throwaway policy) |

## Non-AC follow-ups tracked as gaps (not carryover-blockers)
- Sibling E2E specs task-domain-simple/composite red vs v3 TemplatePicker (cross-feature regression, audit risk #2) → r2 G2
- pipeline-report.md labeling discrepancies (changed-files base, screenshot count) → r2 G3
- dispatch suite assertion density 0.072 on critical 3-path injection → r2 G5
- 31-file env-drift baseline failures → separate future task (out of loop scope)
