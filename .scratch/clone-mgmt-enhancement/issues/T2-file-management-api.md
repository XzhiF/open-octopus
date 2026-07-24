# T2: Clone File Management API

## Status: done

## Summary

Add GET/PUT endpoints for reading and writing clone files (persona.md, config.json) with path whitelist protection against directory traversal.

## Scope

### Server changes

1. **Add to `routes/clone/index.ts`**:
   - `GET /api/clones/:name/files/:path` — read file content from clone directory
   - `PUT /api/clones/:name/files/:path` — write file content to clone directory

2. **Path whitelist**:
   - Only allow: `persona.md`, `config.json`
   - Reject paths with `..`, `/`, or anything outside whitelist
   - Return 403 for non-whitelisted paths

3. **Clone resolution**:
   - Check built-in dir first, then user clones dir
   - Return 404 if clone not found

4. **File read**: return `{ content: string, path: string, size: number }`
5. **File write**: accept `{ content: string }`, validate content size (< 100KB), return `{ ok: true }`

## Verification

### Integration tests (add to `packages/server/src/__tests__/clone-api.test.ts`)

- `GET /api/clones/workspace/files/persona.md` returns persona content
- `GET /api/clones/workspace/files/config.json` returns config content
- `PUT /api/clones/workspace/files/persona.md` updates persona
- `GET /api/clones/workspace/files/../../etc/passwd` returns 403
- `GET /api/clones/workspace/files/secret.txt` returns 403 (not whitelisted)
- `GET /api/clones/nonexistent/files/persona.md` returns 404

## Dependencies

- T1 (API unification must be complete)

## Files to modify

- `packages/server/src/routes/clone/index.ts` — add file management endpoints
- `packages/server/src/__tests__/clone-api.test.ts` — add file management tests
