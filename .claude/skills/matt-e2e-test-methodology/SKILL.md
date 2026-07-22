---
name: matt-e2e-test-methodology
description: E2E automated testing methodology and anti-fake-run standards. Defines execution norms, acceptance criteria, and report formats for API integration tests, browser E2E tests, and contract tests. Use when performing E2E testing, API verification, regression testing, or QA acceptance.
---

# E2E Automated Testing Methodology

## Test Environment

Octopus project — TypeScript monorepo with pnpm.

| Service | Source | Auth |
|---------|--------|------|
| API | `http://localhost:3001/api/` (Hono) | Bearer token (from login or cache) |
| Web App | `http://localhost:3000` (Next.js) | Account login |
| Database | SQLite: `~/.octopus/db/octopus.db` | Use matt-sql-executor skill |
| Cache | N/A | N/A |

## Three Test Modes

### Mode 1: API Integration Tests

End-to-end API verification with cross-validation: API response <-> DB data <-> Cache state.

**Execution steps**:

```
1. Obtain auth token (login or from cache)
2. Record pre-test state (DB query + cache query)
3. Call API (curl or script)
4. Verify API response (assert business field values, not just HTTP 200)
5. DB verification (data correctly written/updated)
6. Cache verification (cache invalidated/updated as expected)
7. Cross-validation (API response <-> DB data <-> Cache state)
8. Data cleanup (delete test data, restore original state)
9. Post-cleanup verification (confirm data cleaned, cache rebuilt)
```

**Auth strategy** (by priority):
1. Find valid token from cache: `SCAN 0 MATCH online_tokens:* COUNT 100`
2. Login via browser automation (Playwright) and extract token
3. Call login API directly (may need encryption handling)

### Mode 2: Browser E2E Tests

Use Playwright via Bash to drive Chromium. Scripts should be standalone and CI/CD friendly.

**Prerequisite**: `npx playwright install chromium`

**Execution steps**:

```
1. Generate Playwright script (.mjs file)
2. Run: node e2e-test.mjs
   - chromium.launch() -> start browser
   - page.goto() -> navigate to admin
   - page.fill() -> login
   - page.click() -> perform operations
   - page.screenshot() -> capture evidence
   - page.on('response') -> intercept API requests
   - Assert UI data <-> API response <-> DB data
3. Collect script output (JSON: screenshot paths, network requests, assertion results)
```

### Mode 3: Contract Tests

For frontend projects without mature E2E frameworks, verify API contract consistency.

**Contract verification checklist**:

```
1. Backend VO field names <-> Frontend TypeScript interface field names match
2. Backend VO field types <-> Frontend expected types match (watch String vs Number)
3. API paths match between backend annotations and frontend enums/constants
4. New API endpoints have corresponding frontend API files created
```

## Anti-Fake-Run Standards (R1-R8)

Every test must pass ALL criteria, otherwise it's flagged as "fake run":

| # | Criterion | Detection Method |
|---|-----------|-----------------|
| R1 | **Real service** | Test log contains real UAT address, not localhost/mock |
| R2 | **Business data** | Asserts specific field values (e.g., name == "test"), not just HTTP 200 |
| R3 | **Cross-validation** | API <-> DB <-> Cache at least two-way comparison |
| R4 | **Evidence** | Includes API response body, DB query result, screenshot (at least two) |
| R5 | **Side effects** | Write ops verify DB change + cache invalidation |
| R6 | **Real user path** | Token obtained through login, not hardcoded |
| R7 | **Data isolation** | Uses identifiable test data (e.g., "E2E_TEST_" prefix), cleaned up after |
| R8 | **Repeatable** | No manual pre-steps required, script is self-contained |

## Test Report Format

```markdown
## E2E Test Report

### Basic Info
- Target: [API path / page / feature]
- Mode: [API Integration / Browser E2E / Contract]
- Environment: local dev (`pnpm dev`, port 3001)
- Timestamp: [ISO 8601]

### Execution Steps
| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Login, get token | PASS | token=xxx... |
| 2 | POST /api/... | PASS | HTTP 200, response={...} |
| 3 | DB verification | PASS | SELECT result: [N rows] |
| 4 | Cache verification | PASS | GET returns (nil), cache invalidated |
| 5 | Cross-validation | PASS | API[N] == DB[N] |
| 6 | Cleanup | PASS | DELETE done, verified cleaned |

### Anti-Fake-Run Check
- [x] R1: Connected to real service
- [x] R2: Asserted specific business data
- [x] R3: Cross-validated API <-> DB <-> Cache
- [x] R4: Provided 2+ evidence items
- [x] R5: Verified side effects (DB + cache)
- [x] R6: Obtained token through login
- [x] R7: Used E2E_TEST_ prefix, cleaned up
- [x] R8: Script is self-contained, repeatable

### Conclusion
**PASS** — All steps passed, anti-fake-run R1-R8 fully satisfied.
```

## Test Case Design Guidelines

### Write Operations (POST/PUT/DELETE)

Must cover:
1. Normal write -> verify DB + cache invalidation
2. Read-back verification -> verify returned data matches DB
3. Auth check -> no token or wrong token returns 401
4. Edge cases -> empty list, null fields, oversized strings
5. Cleanup -> delete test data, verify restoration

### Read Operations (GET)

Must cover:
1. Normal read -> verify field names and types
2. Cache hit -> second read comes from cache (check TTL)
3. Empty data -> non-existent ID returns empty or 404
4. Pagination -> verify pageNum/pageSize correctness

### Privacy-Related APIs (if applicable)

Additional coverage:
1. No privacy header -> verify masked data returned
2. Valid privacy ticket -> verify plaintext data returned
3. Invalid privacy ticket -> verify masked data returned
4. Write with masked data -> verify rejection or ignore
