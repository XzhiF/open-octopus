# Domain docs: Multi-context

This repo uses a multi-context layout. Each bounded context has its own `CONTEXT.md`.

## Layout

- **Map**: `CONTEXT-MAP.md` at the repo root — index of all contexts
- **Contexts**: one `CONTEXT.md` per package that has its own domain
- **ADRs**: `docs/adr/` at repo root for system-wide decisions; per-context `docs/adr/` for context-specific ones

## Package contexts

| Package | Context file | Domain |
|---------|-------------|--------|
| shared  | `packages/shared/CONTEXT.md` | Cross-cutting types, schemas, config |
| providers | `packages/providers/CONTEXT.md` | AI provider abstraction |
| cli | `packages/cli/CONTEXT.md` | CLI commands and user interaction |
| engine | `packages/engine/CONTEXT.md` | Workflow execution engine |
| server | `packages/server/CONTEXT.md` | REST API + SSE + WebSocket |
| web-app | `packages/web-app/CONTEXT.md` | Next.js frontend |
| core-pack | `packages/core-pack/CONTEXT.md` | Bundled skills, agents, workflows |

## Consumer rules

- All engineering skills MUST read the relevant `CONTEXT.md` before making changes in a package
- Use the glossary terms exactly as defined — do not substitute synonyms
- Respect ADRs in the area you're touching
- When a term is resolved, update the appropriate `CONTEXT.md` immediately
