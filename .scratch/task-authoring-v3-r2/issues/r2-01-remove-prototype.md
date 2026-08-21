# r2-01 — 删除 throwaway 原型路由（D12 carryover）

## What to build
删除 `packages/web-app/app/tasks/prototype/` 整个目录（3568 行原型，R6 标记 throwaway，交互参照使命已完成 — 产品组件已按原型重写于 components/tasks/authoring/）。

步骤：
1. `git rm -r packages/web-app/app/tasks/prototype/`
2. grep 验证零引用：`grep -rn "tasks/prototype\|prototype/page" packages/ --include="*.ts" --include="*.tsx"` 应为 0 命中（若有 import/Link 引用则清理）
3. `cd packages/web-app && pnpm build` 验证

## Blocked by
None — 独立文件删除

## Status
done

## Acceptance Criteria
- [x] AC1: `packages/web-app/app/tasks/prototype/` 不存在
- [x] AC2: web-app build 成功（exit 0）
- [x] AC3: packages/ 下零代码引用（.scratch 历史文档引用可保留）

## Verification Method
fs 检查 + `pnpm build`（web-app）+ grep 零命中

## Exploration

**Analog studied**: Pure deletion task — no analogous feature to model. The throwaway prototype at `packages/web-app/app/tasks/prototype/page.tsx` (191864 bytes, single-file route) was already superseded by production components under `packages/web-app/components/tasks/authoring/` (template-picker, authoring-workspace, output-viewer, moa-adoption-panel, workflow-log-dialog, artifact-viewer-dialog, goal-ac-card). Each production component carries an attribution comment noting it was "code rewritten, not copied" from a specific line range of the prototype.

**Files needing modification**: only `packages/web-app/app/tasks/prototype/page.tsx` (delete). No other files require edits — attribution comments in `components/tasks/authoring/*.tsx` are historical notes, kept per launch instruction.

**Reference verification (pre-deletion)**:
- `grep "from ['\"].*tasks/prototype|href=['\"].*tasks/prototype|router\.push\(['\"].*prototype"` across `packages/**/*.{ts,tsx}` → 0 matches (no imports/links/router calls).
- `grep "app/tasks/prototype"` across `packages/**/*.{ts,tsx}` → 7 matches, all single-line `//` attribution comments in `components/tasks/authoring/*.tsx`. No code path references the route.

**Functions chosen**: N/A (deletion only — no logic to call).

**Post-deletion verification**:
- AC1: `ls packages/web-app/app/tasks/prototype/` → "No such file or directory" (git rm'd).
- AC2: `cd packages/web-app && pnpm build` → "Compiled successfully in 13.9s", 20/20 static pages, exit 0; route table no longer lists `/tasks/prototype`.
- AC3: re-grep `tasks/prototype|prototype/page` across `packages/**/*.{ts,tsx}` → same 7 attribution-comment matches, no new code references. Build passing confirms no stale imports.

**TDD note**: Deletion task — no test to write (red→green loop N/A). Verification per ticket: fs + build + grep, all green.
