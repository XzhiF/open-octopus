# Ticket 10: CLI Command

## Scope
- `packages/cli/src/commands/workflow.ts` — add `simulate` subcommand
- Options: --test, --scenario, --strict, --no-strict, --verbose, --json, --real

## Acceptance Criteria
- `octopus workflow simulate <yaml>` runs successfully
- Auto-discovers test fixture
- Outputs formatted results
