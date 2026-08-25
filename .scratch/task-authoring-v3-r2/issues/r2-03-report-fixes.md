# r2-03 — 报告修正 + ticket hygiene

## What to build
Round 1 verification-report §6 发现两处报告口径问题 + 一处 hygiene：

1. `.scratch/task-authoring-v3/pipeline-report.md` 的 "Changed Files" 表误按 `origin/main...HEAD` 计算（providers 声称 4 文件，本迭代实际 0）。修正为 vs 9917e986 口径。正确数字（audit 核定）：82 files, +15430/−106（含报告后两个 doc commits d24b7591/a9fe1206；packages: shared 5 / providers 0 / engine 2 / core-pack 7 / server 21 / web-app 21，余为 tests/.scratch/ADRs）。用 `git diff --shortstat 9917e986...HEAD` + `git diff --name-only 9917e986...HEAD | grep -oE "^ packages/[a-z-]+" | sort | uniq -c` 核实后更新表格（保留"含 tests/E2E/ADRs"说明）。
2. 截图数：e2e-screenshots 现有 19 PNG，其中 `task-domain/A-01-kanban-board.png` 为上一迭代遗留。报告中"19 张截图"改为"18 张 v3-specific 截图（目录内含 1 张上一迭代遗留 PNG）"。同时把遗留 PNG 移到正确归属处或删除（它是 task-domain-redesign 迭代的证据；若 .scratch/task-domain-redesign/ 不存在则直接删除该 PNG 并注明）。
3. `.scratch/task-authoring-v3/issues/01-shared-types-schema.md` 的 AC checkboxes（`## Acceptance Criteria` 下的 `- [ ]`）全部勾选（status 已 done，纯 hygiene）。

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] AC1: pipeline-report.md Changed Files 表与 `git diff --shortstat 9917e986...HEAD` 一致（执行时实时核对）
- [x] AC2: 截图数表述修正 + 遗留 PNG 处置完成
- [x] AC3: ticket-01 checkboxes 全勾

## Verification Method
git diff 对照 + 文件检查

## Exploration

### Analog studied
Docs/hygiene ticket — no code seams to mirror. The "analog" is the report's own existing structure + git diff semantics. No packages/ source written (read-only verification only); the lane is three scratch artifacts: pipeline-report.md, the stray PNG, and ticket-01's checkboxes.

### Files modified (my lane only)
1. `.scratch/task-authoring-v3/pipeline-report.md` — (a) Changed Files table: base `origin/main...HEAD` → `9917e986`; numbers replaced with real `git diff` output. (b) Screenshot count: "19 张" → "18 张 v3-specific" + disposition note.
2. `.scratch/task-authoring-v3/e2e-screenshots/task-domain/A-01-kanban-board.png` — stray PNG disposition (see below).
3. `.scratch/task-authoring-v3/issues/01-shared-types-schema.md` — 4 AC checkboxes → [x].

### Specific commands / decisions chosen
- **Base commit = `9917e986`** (last #43 task-domain-redesign commit), NOT `origin/main...HEAD` (the report's wrong base bundled #43's providers/4 files into #44). Verified via `git log --oneline`: 14 task-authoring-v3 commits (`587c7a01`..`ee3ce0c0`) sit atop `9917e986`.
- **Real-time numbers (AC1)**: `git diff --shortstat 9917e986...HEAD` @ HEAD=`ee3ce0c0` = **85 files, +15801/-106**. Per-package via `git diff --shortstat 9917e986...HEAD -- packages/<pkg>`: shared 5 (+380/-6), providers 0, engine 2 (+159/-2), core-pack 7 (+199/0), server 21 (+4748/-66), web-app 21 (+7878/-32); non-packages 29 (+2437/0) = tests/.scratch/ADRs/CONTEXT-MAP. Arithmetic reconciles exactly (85 files / +15801 / -106). Table carries the verify-command footnote for re-check.
- **Snapshot caveat**: ticket's audit-核定 was 82 files/+15430 (at `a9fe1206`); my real-time is 85/+15801 because `ee3ce0c0` (r1 verification handoff) added 3 files/+371 after the audit. AC1 demands "执行时实时核对" → table matches command output at execution, with HEAD commit noted for auditability. Per-package breakdown is stable (r2-01 prototype `D` + r2-02 spec `M` are uncommitted, not in the committed diff).
- **Stray PNG disposition (AC2)**: `.scratch/task-domain-redesign/` EXISTS → per instructions MOVE (not delete). `task-domain/A-01-kanban-board.png` (27414 bytes) → `.scratch/task-domain-redesign/e2e-screenshots/A-01-kanban-board.png`; empty `task-domain/` subdir removed. Verified: dest exists, source gone, remaining v3 PNGs = 18. Screenshots are git-ignored (`.gitignore:72 e2e-screenshots/`) → plain filesystem move, no git mv/staging (also why PNGs don't appear in `git diff`).
- **ticket-01 boxes (AC3)**: NOT checked blindly — material-verified all 4 ACs read-only against `packages/shared/src/types/{scheduler-job,task}.ts`: AC1 (5 taskSpecSchema fields present), AC2 (`"decisions"` in TaskSpecFieldSchema + `case "decisions":` in validateSpecFieldValue throwing TaskSpecFieldError), AC3 (ArtifactIndexEntry + AssistWorkflowRun types), AC4 (`goal: z.string().min(1)` + `ac: z.array(z.string().min(1)).min(1)` intact). All met → checked.

### Lane boundaries respected
- No packages/ source files modified (read-only verification only). r2-01 (prototype page.tsx `D`) and r2-02 (task-domain-simple.spec.ts `M`) uncommitted in working tree — not mine, untouched.
