# Ticket 1: Data Layer — interaction_messages Table, DAO, Types

## Summary
Create the `interaction_messages` table in the database schema, add the DAO class, and define TypeScript types. This is the foundation for all subsequent tickets.

## Scope

### 1.1 Schema Changes (`packages/server/src/db/schema.sql`)

Add new table after `llm_calls` (table #12):

```sql
-- 29. Interaction Messages
CREATE TABLE IF NOT EXISTS interaction_messages (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_interaction_msgs_exec_node
  ON interaction_messages(execution_id, node_id, created_at ASC);
```

### 1.2 Type Definition (`packages/server/src/db/types.ts`)

```typescript
export interface InteractionMessageRow {
  id: string
  execution_id: string
  node_id: string
  role: "user" | "assistant" | "system"
  type: "text" | "thinking" | "tool_call" | "ask_user_question"
  content: string
  metadata: string | null
  created_at: string
}
```

### 1.3 DAO (`packages/server/src/db/dao/interaction-message-dao.ts`)

```typescript
import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { InteractionMessageRow } from "../types"

export class InteractionMessageDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  insertMessage(row: InteractionMessageRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.execution_id, row.node_id, row.role, row.type, row.content, row.metadata, row.created_at)
  }

  findMessages(executionId: string, nodeId: string, opts?: { limit?: number; before?: string }): InteractionMessageRow[] {
    if (opts?.before) {
      const limit = opts.limit ?? 100
      return this.stmt(
        "SELECT * FROM interaction_messages WHERE execution_id = ? AND node_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
      ).all(executionId, nodeId, opts.before, limit) as InteractionMessageRow[]
    }
    const limit = opts?.limit ?? 100
    return this.stmt(
      "SELECT * FROM interaction_messages WHERE execution_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT ?"
    ).all(executionId, nodeId, limit) as InteractionMessageRow[]
  }

  findMessageById(id: string): InteractionMessageRow | null {
    return (this.stmt("SELECT * FROM interaction_messages WHERE id = ?").get(id) as InteractionMessageRow) ?? null
  }

  countMessages(executionId: string, nodeId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM interaction_messages WHERE execution_id = ? AND node_id = ?"
    ).get(executionId, nodeId) as { count: number }).count
  }

  updateMessageMetadata(id: string, metadata: string): Database.RunResult {
    return this.stmt("UPDATE interaction_messages SET metadata = ? WHERE id = ?").run(metadata, id)
  }

  deleteMessagesByExecution(executionId: string): Database.RunResult {
    return this.stmt("DELETE FROM interaction_messages WHERE execution_id = ?").run(executionId)
  }
}
```

### 1.4 Export from DAO Index (`packages/server/src/db/dao/index.ts`)

Add export:
```typescript
export { InteractionMessageDAO } from "./interaction-message-dao"
```

### 1.5 Schema Version (`packages/server/src/db/schema.ts`)

No migration needed for new table (idempotent `CREATE TABLE IF NOT EXISTS`). Bump `SCHEMA_VERSION` by 1.

## Files to Create
- `packages/server/src/db/dao/interaction-message-dao.ts`

## Files to Modify
- `packages/server/src/db/schema.sql` — add table + index
- `packages/server/src/db/types.ts` — add `InteractionMessageRow`
- `packages/server/src/db/dao/index.ts` — add export
- `packages/server/src/db/schema.ts` — bump SCHEMA_VERSION

## Verification
- [ ] `pnpm build` passes (all packages)
- [ ] `pnpm test` passes
- [ ] Unit test: InteractionMessageDAO CRUD operations
