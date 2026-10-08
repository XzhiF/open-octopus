# Domain docs: Multi-context

This repo uses a multi-context layout. Each bounded context has its own `GLOSSARY.md`.

## Layout

- **Map**: `GLOSSARY-MAP.md` at the repo root — index of all contexts
- **Contexts**: one `GLOSSARY.md` per package that has its own domain
- **ADRs**: `docs/adr/` at repo root for system-wide decisions; per-context `docs/adr/` for context-specific ones

## Package contexts

| Package | Context file | Domain |
|---------|-------------|--------|
| shared  | `packages/shared/GLOSSARY.md` | Cross-cutting types, schemas, config |
| providers | `packages/providers/GLOSSARY.md` | AI provider abstraction |
| cli | `packages/cli/GLOSSARY.md` | CLI commands and user interaction |
| engine | `packages/engine/GLOSSARY.md` | Workflow execution engine |
| server | `packages/server/GLOSSARY.md` | REST API + SSE + WebSocket |
| web-app | `packages/web-app/GLOSSARY.md` | Next.js frontend |
| core-pack | `packages/core-pack/GLOSSARY.md` | Bundled skills, agents, workflows |

## Consumer rules

- All engineering skills MUST read the relevant `GLOSSARY.md` before making changes in a package
- Use the glossary terms exactly as defined — do not substitute synonyms
- Respect ADRs in the area you're touching
- When a term is resolved, update the appropriate `GLOSSARY.md` immediately
