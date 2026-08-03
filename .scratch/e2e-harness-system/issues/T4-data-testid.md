# T4: Web-app data-testid additions

## Status: DONE

## Scope

Add ≥20 data-testid attributes to key web-app components:
- create-workspace-dialog.tsx
- workspace-card.tsx
- workspace-list.tsx
- workspaces/page.tsx
- workspace detail page
- workflow-flow-panel.tsx

## Verification Method

`grep -r "data-testid" packages/web-app/components/ | wc -l` ≥ existing + 20
