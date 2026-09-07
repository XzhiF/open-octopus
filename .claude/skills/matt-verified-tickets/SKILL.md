---
name: matt-verified-tickets
description: Enhancement of to-tickets. Adds verification method binding — every ticket gets executable verification steps. Used as a guide by the main session during matt-verified-requirement.
reference-only: true
---

# Verified Tickets — Enhancement of `to-tickets`

> **This skill enhances `to-tickets`.** Follow `to-tickets` for the base process (tracer bullet splitting, blocking edges, publishing), then add the verification enhancements below.
> It is a methodology reference — the main session reads it when writing issues/ during `matt-verified-requirement`. NOT auto-invoked by any agent.

## Base Skill

Follow `to-tickets` for:
- **Process**: Gather context → Explore codebase → Draft vertical slices → Quiz user → Publish
- **Tracer bullet principles**: narrow end-to-end path, demoable independently, one session size, prefactoring first
- **Blocking edges**: each ticket declares what blocks it (this creates the DAG)
- **Split ordering**: DB → Entity → Service → Controller → Frontend API → Pages → E2E
- **Publishing**: one file per ticket under `<artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md`

## Enhancements (补充 Verification Methods)

The core enhancement: each ticket gets a **Verification Method** section in addition to Acceptance Criteria.

### Add to `to-tickets` template — insert after Acceptance Criteria:

```markdown
## Verification Method

**Verification type**: [unit test / integration test / contract test / manual checklist]（功能票限此四类；**browser E2E 只出现在末张 `NN-e2e-*` 验收票**——见 Rule 5）

**Prerequisites**:
- [ ] [e.g., backend compiles]
- [ ] [e.g., test data is ready]

**Verification steps**:

### Unit Tests (if applicable)

cd <project-root>
pnpm test  # Vitest

Pass criteria: All test methods PASS

### Integration Tests (if applicable)

Step 1: Get token
Step 2: Record pre-test state (DB query)
Step 3: Call API
Step 4: Verify API response (assert business fields)
Step 5: DB verification
Step 6: Cache verification
Step 7: Cross-validation: API <-> DB <-> Cache
Step 8: Cleanup

### Browser E2E（仅末张 `NN-e2e-*` 验收票，功能票禁写）

1. Playwright script: login -> navigate -> operate -> assert -> screenshot

### Contract Verification (if applicable)

- [ ] Backend VO fields <-> Frontend interface fields match
- [ ] API paths match between backend and frontend
- [ ] Field types match (watch String vs Number)

### Manual Checklist (if applicable)

- [ ] V1: [specific check]
- [ ] V2: [specific check]

**Pass criteria**: All verification steps PASS, evidence chain complete
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
```

## Additional Rules (beyond `to-tickets`)

1. **Every ticket MUST have a Verification Method** — no verification = incomplete ticket
2. **Executable verification** — specific commands, specific SQL, specific assertions (not "test the API")
3. **DAG structure** — tickets without mutual blockers can run concurrently in the same stage (consumed by `matt-dev-pipeline` Phase 1)
4. **One session size** — each ticket's implementation + verification fits in one matt-dev-runner agent call
5. **Verification-type ladder（browser 去重）** — 功能票的验证类型限 unit / integration(API↔DB 交叉) / contract / manual：不起 dev server 走浏览器、不做故事走查。UI 功能票的渲染与交互断言（列齐全/徽标/换算即时生效等）**收编为末张 `NN-e2e-*` 票的走查步骤**，功能票本体只验到 API 响应 + DB 直查。全 phase 真起浏览器 + 留截图证据的地方**恒唯一 = 末张验收票**（否则同一 UI 检查双跑，白烧 vision/playwright 成本）。末张票模式**随验收面自动选**：有 UI/页面交互 → browser 走查；纯后端/无 UI phase → API 级走查（curl+sqlite+手算，天然形态无需声明——不给不存在的页面烧成本）。有 UI 时若 spec 验证纪律显式拍板「全流程不做浏览器 E2E」，末张同为 API 级——但功能票禁令无条件，不随该拍板豁免。
