# 07 — Frontend UI

Type: grilling
Status: resolved

## Question
What frontend changes are needed for the evolution system?

## Answer
Complete evolution UI in the web-app:

1. **Evolution Panel** (new page/section):
   - Evolution history timeline
   - Patch diff viewer (old vs new, syntax highlighted)
   - Review results display (reviewer feedback, accept/reject)
   - Manual trigger button per clone
   - Rollback button per applied patch

2. **Workflow Editor**:
   - New `system_agent` node type in the palette
   - Configuration form: role, clone selection, evolution settings
   - Visual indicator for nodes with evolution enabled

3. **Clone Detail Page**:
   - Evolution stats (patches applied, success rate, last evolution date)
   - Current vs previous persona/skills comparison

**Reason**: Evolution without visibility is a black box. Users need to understand, approve, and intervene in the evolution process.
