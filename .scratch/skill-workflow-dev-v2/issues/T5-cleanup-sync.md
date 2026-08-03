# Ticket T5: Cleanup Old Skills + Core-pack Sync + Final Verification

## Status
DONE

## Scope

### Cleanup
1. Delete `.claude/skills/octo-swarm-dev/` directory
2. Delete `.claude/skills/octo-workflow-test/` directory
3. Delete `packages/core-pack/skills/octo-swarm-dev/` directory
4. Delete `packages/core-pack/skills/octo-workflow-test/` directory

### Core-pack Sync
5. Copy `.claude/skills/octo-workflow-dev/` → `packages/core-pack/skills/octo-workflow-dev/`
   - SKILL.md
   - references/ (all 8 files)
   - scripts/validate-workflow.js

### Final Verification
6. Verify all 8 reference docs exist in both locations
7. Verify SKILL.md references all resolve to existing files
8. Verify validate-workflow.js is executable
9. Run validate-workflow.js on a comprehensive test workflow
10. Verify no references to deleted skills remain

## Verification Method
- `.claude/skills/octo-swarm-dev/` does not exist
- `.claude/skills/octo-workflow-test/` does not exist
- `packages/core-pack/skills/octo-swarm-dev/` does not exist
- `packages/core-pack/skills/octo-workflow-test/` does not exist
- File count match between .claude/skills/octo-workflow-dev/ and core-pack copy
- All SKILL.md reference links resolve
- validate-workflow.js runs successfully on test YAML
- No "octo-swarm-dev" or "octo-workflow-test" strings in new SKILL.md
