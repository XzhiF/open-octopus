# Ticket 3: Interaction Route — REST API + SSE Streaming

## Summary
Create the interaction route that exposes the InteractionService via REST API with SSE streaming. Register it under the workspace routes.

## Scope

### 3.1 Route File (`packages/server/src/routes/interaction.ts`)

```typescript
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

const interaction = new Hono()

// POST /:execId/:nodeId/start — Initialize interaction session
interaction.post("/:execId/:nodeId/start", async (c) => {
  const { execId, nodeId } = c.req.param()
  const workspaceId = c.req.param("id")  // from parent route
  // Call interactionService.startInteraction(...)
  // Return { sessionId }
})

// POST /:execId/:nodeId/messages — Send message, stream SSE response
interaction.post("/:execId/:nodeId/messages", async (c) => {
  const body = await c.req.json()
  return streamSSE(c, async (stream) => {
    const abortController = new AbortController()
    stream.onAbort(() => abortController.abort())
    
    for await (const event of interactionService.sendMessage({
      executionId: execId, nodeId, content: body.content,
    })) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  })
})

// GET /:execId/:nodeId/messages — Get message history
interaction.get("/:execId/:nodeId/messages", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100)
  const before = c.req.query("before")
  // Return InteractionMessageRow[]
})

// POST /:execId/:nodeId/complete — Force complete
interaction.post("/:execId/:nodeId/complete", async (c) => {
  const body = await c.req.json()
  // Call interactionService.forceComplete(...)
  // Return { ok: true }
})

// GET /:execId/:nodeId/status — Get interaction status
interaction.get("/:execId/:nodeId/status", async (c) => {
  // Return session info from InteractionService
})
```

### 3.2 Route Registration

Register in `packages/server/src/routes/chain-routes.ts` or wherever workspace sub-routes are mounted:

```typescript
import interaction from "./interaction"
app.route("/api/workspaces/:id/interactions", interaction)
```

### 3.3 Service Resolution

The route needs access to `InteractionService`. Follow the existing pattern used by other routes (service registry or DI container).

## Files to Create
- `packages/server/src/routes/interaction.ts`

## Files to Modify
- `packages/server/src/routes/chain-routes.ts` (or equivalent) — register route

## Verification
- [ ] `pnpm build` passes
- [ ] Route compiles with correct Hono types
- [ ] Manual test: POST to start endpoint returns sessionId
