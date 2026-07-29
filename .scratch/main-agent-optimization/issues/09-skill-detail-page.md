# Issue 09: Skill Detail Page

**Status:** pending
**Scope:** web-app
**Files:** `packages/web-app/components/agent/skill/SkillDetailView.tsx`, `packages/web-app/components/agent/skill/SkillTab.tsx`, `packages/web-app/components/agent/skill/SkillList.tsx`, `packages/web-app/lib/agent/api.ts`, `packages/server/src/routes/agent/skill-routes.ts`

## Description
Create SkillDetailView component with 3-panel resizable layout (skill list | content editor | diff viewer). Add PUT /skills/:name route. Wire click-to-navigate in SkillList/SkillTab.

## Acceptance Criteria
- 3-panel resizable layout using react-resizable-panels
- Markdown preview + edit toggle in content panel
- PUT /skills/:name saves content
- Back navigation to skill list

## Verification
- `pnpm build` succeeds
