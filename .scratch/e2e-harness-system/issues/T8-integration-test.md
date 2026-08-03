# T8: Integration test — full lifecycle

## Status: DONE

## Scope

Create `tests/integration-test.mjs` that exercises:
1. Health check
2. Create workspace
3. Create workflow
4. Execute workflow
5. Poll completion
6. Verify results
7. Browser screenshot
8. Cleanup
9. Print report

## Verification Method

`node -c tests/integration-test.mjs` → syntax OK
