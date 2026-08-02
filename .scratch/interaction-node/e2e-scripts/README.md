# E2E Test Scripts for Interaction Node

This directory contains automated E2E integration tests for the interaction node feature.

## Test Scripts

### 1. test-chatbridge-db.mjs
**Purpose**: Tests ChatBridge database operations directly with SQLite
**Run**: `cd packages/server && node ../../.scratch/interaction-node/e2e-scripts/test-chatbridge-db.mjs`
**Tests**: 7 (schema verification, CRUD operations, status transitions)
**Anti-Fake-Run**: R1-R8 compliant

### 2. test-interaction-api.mjs
**Purpose**: Tests interaction API routes with DB cross-validation
**Run**: `cd packages/server && node ../../.scratch/interaction-node/e2e-scripts/test-interaction-api.mjs`
**Tests**: 24 (API endpoints, error handling, DB operations, multi-session support)
**Requirements**: Server must be running on localhost:3001
**Anti-Fake-Run**: R1-R8 compliant

### 3. test-contract.mjs
**Purpose**: Verifies frontend-backend type consistency
**Run**: `node .scratch/interaction-node/e2e-scripts/test-contract.mjs`
**Tests**: 44 (shared types, engine types, DB schema, API routes, SSE events, UI components)
**Anti-Fake-Run**: R1-R8 compliant

## Quick Start

```bash
# Start dev server (if not already running)
pnpm dev

# Run all E2E tests
cd packages/server && node ../../.scratch/interaction-node/e2e-scripts/test-chatbridge-db.mjs
cd packages/server && node ../../.scratch/interaction-node/e2e-scripts/test-interaction-api.mjs
cd /path/to/repo && node .scratch/interaction-node/e2e-scripts/test-contract.mjs

# Run unit tests
pnpm test
```

## Test Data

All tests use the `E2E_TEST_INTERACTION_` prefix for test data and automatically clean up after themselves.

## Results

See `.scratch/interaction-node/e2e-screenshots/e2e-test-report.md` for detailed results.

## Notes

- Tests require the server to be built (`pnpm build`) and running (`pnpm dev`)
- Database tests use the real SQLite database at `~/.octopus/db/octopus.db`
- No authentication required for local dev environment
- All tests are idempotent and can be run multiple times
