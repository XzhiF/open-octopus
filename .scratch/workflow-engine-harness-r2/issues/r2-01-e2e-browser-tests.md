# R2-01 — E2E Browser Tests (Playwright)

## What to build
Write and execute Playwright browser E2E tests for the harness UI components.

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] AC1: Playwright test verifies floating panel appears during running execution
- [x] AC2: Playwright test verifies collapsed state shows intervention count
- [x] AC3: Playwright test verifies expand/collapse toggle works
- [x] AC4: Playwright test verifies chatbot input and send button
- [x] AC5: Tests execute against real dev server (not mocked)

## Verification Method
**Verification type**: browser E2E (Playwright)
**Verification steps**: Start dev server → run Playwright tests → verify screenshots
**Pass criteria**: All 5 ACs verified with screenshots
