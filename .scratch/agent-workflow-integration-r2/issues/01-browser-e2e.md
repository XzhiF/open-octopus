# 01 — Browser E2E: Versions Tab + OctopusAgentNode

## What to build
Playwright E2E tests for the Versions Tab UI components and OctopusAgentNode rendering.

## Blocked by
None

## Status
done

## Acceptance Criteria
- [ ] AC1: Playwright test: clone detail page has Versions Tab visible
- [ ] AC2: Playwright test: clicking Versions Tab shows version list (or empty state)
- [ ] AC3: Playwright test: Publish dialog opens with version/stage/changelog fields
- [ ] AC4: Playwright test: version list renders stage badges (alpha/beta/rc/stable) with correct colors
- [ ] AC5: Playwright test: OctopusAgentNode renders in workflow viewer with rose color scheme

## Verification Method
**Verification type**: Browser E2E (Playwright)
**Verification steps**: `cd packages/web-app && npx playwright test e2e/versions-tab.spec.ts`
**Pass criteria**: All 5 tests pass against running dev server
**Failure handling**: Max 3 fix attempts
