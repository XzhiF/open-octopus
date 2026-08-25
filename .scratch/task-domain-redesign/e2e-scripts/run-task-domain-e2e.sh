#!/usr/bin/env bash
# .scratch/task-domain-redesign/e2e-scripts/run-task-domain-e2e.sh
#
# Phase 4 runner for the task-domain E2E specs (ticket 12). Sets the env vars
# the spec helpers expect + runs only the 4 task-domain spec files.
#
# Usage:
#   ./.scratch/task-domain-redesign/e2e-scripts/run-task-domain-e2e.sh
#   E2E_ARTIFACTS_DIR=/tmp/e2e-artifacts ./.scratch/task-domain-redesign/e2e-scripts/run-task-domain-e2e.sh
#
# Prerequisites (R1: real server + task-author clone + scheduler):
#   - pnpm dev running (server:3001 web:3000)
#   - Claude SDK provider configured (task-author chat produces content)
#   - ~/.octopus/db/octopus.db exists (node:sqlite reads it for DB assertions)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")../../.." && pwd)"
WEB_APP="${REPO_ROOT}/packages/web-app"

# Defaults — can be overridden by the caller.
export OCTOPUS_SERVER_URL="${OCTOPUS_SERVER_URL:-http://localhost:3001}"
export E2E_ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-${REPO_ROOT}/.scratch/task-domain-redesign/e2e-artifacts}"

echo "[run-task-domain-e2e] server=${OCTOPUS_SERVER_URL}"
echo "[run-task-domain-e2e] artifacts=${E2E_ARTIFACTS_DIR}"
echo "[run-task-domain-e2e] db=${OCTOPUS_DB_PATH:-~/.octopus/db/octopus.db}"

cd "${WEB_APP}"

# Run the 4 task-domain spec files only. Use the main playwright.config.ts
# (auto-starts the web-app webServer if not running).
npx playwright test \
  task-domain-simple.spec.ts \
  task-domain-composite.spec.ts \
  task-domain-draft-linkage.spec.ts \
  task-domain-crash-abort.spec.ts \
  --reporter=list \
  --workers=1 \
  "$@"
