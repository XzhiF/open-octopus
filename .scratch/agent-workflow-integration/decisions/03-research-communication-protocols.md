# 03 — Research: Agent Communication & Delegation Protocols

Type: research
Status: resolved
Blocked by: None

## Question

What are the industry standards and protocols for inter-agent communication and task delegation? Focus on:
- Google A2A (Agent-to-Agent) protocol specification
- FIPA-ACL / KQML agent communication languages
- MCP (Model Context Protocol) for tool/resource sharing
- Message passing patterns: request/response, pub/sub, blackboard
- Structured delegation protocols: task context, SOP, result schema
- State transfer between orchestrator and agent sessions
- How frameworks handle conversation context injection for delegated tasks

## Answer

---

### 1. Google A2A (Agent-to-Agent) Protocol

**Source**: [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) · [GitHub](https://github.com/a2aproject/A2A) · [Google Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)

Announced April 9, 2025 at Google Cloud Next '25. Open standard with 50+ industry partners. Complements MCP: **A2A = agent↔agent, MCP = agent↔tool/data**.

#### 1.1 Three-Layer Architecture

| Layer | Name | Purpose |
|-------|------|---------|
| 1 | Canonical Data Model | Core data structures (Protocol Buffers) |
| 2 | Abstract Operations | Protocol-agnostic capabilities |
| 3 | Protocol Bindings | JSON-RPC, gRPC, HTTP/REST |

#### 1.2 Core Data Model

**Task** — Fundamental unit of work:
- `id` (UUID, server-generated), `contextId` (groups related tasks), `status` (TaskStatus), `artifacts` (output), `history` (Message[]), `metadata`

**Task Lifecycle States**:
- `SUBMITTED` → `WORKING` → `COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` (terminal)
- `INPUT_REQUIRED` / `AUTH_REQUIRED` (interrupted, resumable)

**Message** — One communication turn:
- `messageId`, `role` (USER | AGENT), `parts` (Text | File | Structured Data), `metadata`, `referenceTaskIds`

**Part** — Smallest content unit (OneOf):
- `text` (string), `raw` (bytes/base64), `url` (file reference), `data` (arbitrary JSON)

**Artifact** — Task output (composed of Parts), stored within Task.

#### 1.3 Agent Discovery: Agent Card

JSON metadata at well-known URI describing:
- Identity, provider, capabilities (streaming, pushNotifications, extendedAgentCard)
- Skills (AgentSkill[]), endpoints (AgentInterface[]), auth requirements
- Cryptographic signature for verification
- **Public Card** (unauthenticated) vs **Extended Card** (authenticated, richer details)

#### 1.4 Protocol Operations

| Operation | Description |
|-----------|-------------|
| `SendMessage` | Primary interaction entry. Returns Task or Message. Blocking (default) or Non-Blocking (`returnImmediately`). |
| `SendStreamingMessage` | Real-time SSE/gRPC streaming of Task lifecycle events |
| `GetTask` | Poll current task state |
| `ListTasks` | Filter + cursor-paginate tasks (max 100/page) |
| `CancelTask` | Idempotent cancellation |
| `SubscribeToTask` | Stream updates for existing task |
| Push Notification CRUD | Webhook-based async updates via HTTP POST |
| `GetExtendedAgentCard` | Authenticated capability discovery |

#### 1.5 Streaming & Update Delivery

| Mechanism | Latency | Connection | Best For |
|-----------|---------|------------|----------|
| Polling (GetTask) | Higher | None | Simple integrations |
| Streaming | Low | Persistent | Interactive apps |
| Push Notifications | Async | Webhook | Long-running tasks |

Streaming rules: events delivered in order, multiple concurrent streams per task, closing one stream doesn't affect others.

#### 1.6 Multi-Turn Conversation

- `contextId` groups related tasks/messages across turns
- `taskId` references existing tasks for follow-up
- `referenceTaskIds` for cross-task context
- Server rejects messages with mismatching contextId/taskId

#### 1.7 Authentication

Supports: API Key, HTTP Auth (Bearer), OAuth 2.0 (Auth Code, Client Credentials, Device Code), OpenID Connect, Mutual TLS. In-task auth via `TASK_STATE_AUTH_REQUIRED`.

#### 1.8 Relevance to Octopus

A2A provides a **production-grade inter-agent protocol** that could enable Octopus agents (or external agents) to discover and delegate tasks to each other. The Agent Card pattern maps well to Octopus's existing `AgentConfig` system. The Task lifecycle states align with Octopus's `ExecutionLifecycle` states. Key gap: A2A is designed for **cross-organization** agent interop; Octopus's internal agent communication is tighter (shared VarPool, shared DB). **Recommendation**: Adopt A2A-compatible Agent Cards for external agent integration; keep internal communication lighter.

---

### 2. FIPA-ACL / KQML — Classic Agent Communication Languages

**Sources**: [FIPA ACL Spec (FIPA00061)](https://www.fipa.org/specs/fipa00061/SC00061G.html) · [Wikipedia](https://en.wikipedia.org/wiki/Agent_Communications_Language) · [Academia comparison](https://www.academia.edu/88620133/Agent_Communication_Languages_Comparison_Fipa_Acl_and_KQML)

#### 2.1 KQML (Knowledge Query and Manipulation Language)

- Originated from DARPA's Knowledge Sharing Initiative (early 1990s)
- Based on **speech act theory** — messages are communicative acts
- Defines performatives like `ask-one`, `tell`, `request`, `advertise`
- Two layers: **Message Layer** (performatives) + **Content Layer** (KIF-based content)
- Facilitator-based routing: agents register with facilitators who route messages

#### 2.2 FIPA-ACL

Refined KQML into a more rigorous standard (late 1990s–2000s). **22 standard performatives**:

| Performative | Semantic |
|-------------|----------|
| `inform` | Assert a proposition |
| `request` | Request an action |
| `agree` / `refuse` | Accept/reject a request |
| `propose` | Propose an action/offer |
| `cfp` (Call for Proposals) | Initiate contracting protocol |
| `accept-proposal` / `reject-proposal` | Respond to CFP |
| `query-ref` | Ask for a referent |
| `inform-if` / `confirm` / `disconfirm` | Conditional assertions |
| `not-understood` | Signal comprehension failure |
| `cancel` / `failure` / `subscribe` | Control performatives |

**Message Structure** (required fields):
- `sender`, `receiver`, `content`, `language`, `ontology`, `performative`

**Conversation Protocols** (FIPA Interaction Protocols):
- **Request Protocol**: request → agree/refuse → inform/failure
- **Contract Net Protocol**: cfp → propose/reject → accept/reject → inform/failure
- **Subscribe Protocol**: subscribe → agree/refuse → inform* (recurring)
- **Auction Protocol**: cfp → propose* → accept/reject → inform

#### 2.3 Ontologies

Both KQML and FIPA-ACL separate **communication** (performatives) from **content semantics** (ontologies). An ontology defines the vocabulary and relationships used in message content. FIPA specifies:
- Content languages: SL (Semantic Language), Prolog, KIF
- Ontology service: agents register ontologies for shared understanding

#### 2.4 Relevance to Octopus

FIPA-ACL's performative model provides a **theoretical foundation** for structured agent messages. The Contract Net Protocol is particularly relevant for Octopus's swarm/debate modes where multiple agents bid on or evaluate proposals. However, FIPA-ACL is heavyweight for LLM-based agents — the performatives map better to **structured output schemas** than to explicit protocol messages. **Recommendation**: Borrow the performative vocabulary (request, inform, propose, agree, refuse) as a **message intent taxonomy** for Octopus agent communication; skip the full FIPA stack.

---

### 3. MCP (Model Context Protocol)

**Sources**: [MCP Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18) · [Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) · [GitHub](https://github.com/modelcontextprotocol)

#### 3.1 Architecture: Client-Host-Server

```
Host (LLM Application)
├── Client 1 ←→ Server 1 (Files & Git)
├── Client 2 ←→ Server 2 (Database)
└── Client 3 ←→ Server 3 (External APIs)
```

- **Host**: LLM application container. Creates/manages clients, enforces security, handles user auth, coordinates LLM integration.
- **Client**: 1:1 connection to a server. Stateful session, protocol negotiation, bidirectional routing.
- **Server**: Provides focused capabilities. Cannot see full conversation or other servers.

**Design Principle**: Servers are isolated — they receive only necessary context, full conversation stays with host.

#### 3.2 JSON-RPC 2.0 Base Protocol

All communication uses JSON-RPC 2.0. Stateful connections with capability negotiation at initialization.

#### 3.3 Capability Negotiation

Both sides declare supported features during `initialize`:
- Servers declare: resource subscriptions, tool support, prompt templates
- Clients declare: sampling support, notification handling
- Features not declared are unavailable for the session

#### 3.4 Server Primitives

| Primitive | Purpose |
|-----------|---------|
| **Resources** | Context and data (files, DB records, API responses). URI-addressed. Subscribable for updates. |
| **Tools** | Executable functions for the AI model. JSON Schema input/output. Annotations for safety. |
| **Prompts** | Templated messages and workflows. Parameterized. |

#### 3.5 Client Primitives

| Primitive | Purpose |
|-----------|---------|
| **Sampling** | Server-initiated LLM calls through the client. Host controls approval, prompt visibility, and result scope. |
| **Roots** | Server-initiated filesystem/URI boundary queries. |
| **Elicitation** | Server-initiated requests for user input. |

#### 3.6 Security Model

1. **User Consent**: All data access and operations require explicit consent
2. **Data Privacy**: Hosts cannot transmit resource data without consent
3. **Tool Safety**: Tool descriptions considered untrusted; explicit approval required
4. **Sampling Controls**: Users approve sampling, control prompt visibility, limit server access

#### 3.7 MCP vs A2A — Complementary Roles

| Aspect | MCP | A2A |
|--------|-----|-----|
| Direction | Agent ↔ Tool/Data | Agent ↔ Agent |
| Relationship | Client-Server (1:1 per session) | Peer-to-Peer |
| State | Session-scoped | Task-scoped with lifecycle |
| Discovery | Manual config / server registry | Agent Card at well-known URI |
| Content | Resources, Tools, Prompts | Tasks, Messages, Artifacts |

#### 3.8 Relevance to Octopus

Octopus already uses MCP for tool/resource sharing. MCP's isolation principle (servers can't see each other) aligns with Octopus's executor isolation. **Recommendation**: Continue using MCP for tool integration. For agent-to-agent delegation, layer A2A or an Octopus-specific protocol on top. Consider exposing Octopus agent capabilities as MCP resources for discovery by external systems.

---

### 4. Message Passing Patterns

**Sources**: [Wikipedia: Blackboard System](https://en.wikipedia.org/wiki/Blackboard_system) · [Openlayer Multi-Agent Guide](https://www.openlayer.com/blog/post/multi-agent-system-architecture-guide) · [Tuple Spaces (Linda)](https://www.croftpress.com/david/research/agent/tuplespaces/) · [Azure Pub/Sub Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/publisher-subscriber)

#### 4.1 Request/Response (Synchronous)

- Sender issues request, blocks until response received
- Best for: immediate confirmation, data retrieval, queries
- Implementation: HTTP, gRPC, JSON-RPC
- **Octopus usage**: CLI `workflow run`, Server REST API, Agent Executor tool calls

#### 4.2 Publish/Subscribe (Asynchronous)

- Publishers emit to topics; subscribers react to subscribed topics
- Fully decoupled: publishers don't know subscribers
- Best for: event streaming, fan-out notifications, loose coupling
- Implementation: SSE, WebSocket, message brokers
- **Octopus usage**: SSE event streaming from server to web-app, execution events

#### 4.3 Blackboard Architecture

- **Shared memory space** ("blackboard") where multiple agents ("knowledge sources") read partial solutions and contribute refinements
- Agents don't communicate directly — only through the blackboard
- Components: Blackboard (shared state), Knowledge Sources (agents), Controller (attention focus)
- Origins: 1970s–80s AI (HEARSAY-II, BB1)
- **Modern LLM variant**: MetaGPT's shared message pool where agents publish structured outputs
- **Octopus mapping**: VarPool serves as a lightweight blackboard; SQLite execution records provide persistent blackboard state

#### 4.4 Tuple Spaces (Linda)

- Processes communicate by writing/reading structured tuples in shared memory
- **Decoupled**: agents don't need each other's identities
- Operations: `out(tuple)` (write), `in(template)` (read+remove), `rd(template)` (read), `eval(process)` (spawn)
- Associative matching: read by template pattern, not by address
- Extensions: sTuples (semantic matching), TuCSoN (multi-agent coordination)
- **Octopus mapping**: `$node-id.output.xxx` variable resolution is a form of tuple-space read — agents publish structured output tuples, downstream agents read by pattern

#### 4.5 Comparison Matrix

| Pattern | Coupling | Sync | Scalability | Complexity |
|---------|----------|------|-------------|------------|
| Request/Response | Tight | Yes | Limited | Low |
| Pub/Sub | Loose | No | High | Medium |
| Blackboard | Shared state | Either | Medium | Medium |
| Tuple Space | Very loose | No | High | High |

#### 4.6 Relevance to Octopus

Octopus currently blends **Request/Response** (tool calls, REST API) + **Pub/Sub** (SSE events) + **Blackboard** (VarPool shared state). For the agent delegation system, a **hybrid approach** is recommended:
- Request/Response for direct agent-to-agent delegation
- Blackboard (VarPool) for shared working memory
- Pub/Sub for execution lifecycle events
- Tuple-space-like pattern for `$node-id.output` variable resolution

---

### 5. Structured Delegation Protocols

**Sources**: [Brainfile Agent Contracts](https://brainfile.md/guides/contracts) · [strands-agents/agent-sop](https://github.com/strands-agents/agent-sop) · [Task Handoff Patterns](https://tpiros.dev/blog/multi-agent-systems-and-task-handoff/) · [OpenAI Agent Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)

#### 5.1 Agent-to-Agent Contracts (Brainfile Model)

Structured YAML contracts embedded in task files:

```yaml
contract:
  status: ready | in_progress | delivered | done | blocked | failed
  deliverables:
    - type: file
      path: src/example.ts
      description: Core implementation
  validation:
    commands:
      - "npm test"
      - "npm run lint"
  constraints:
    - "No external API calls"
    - "Max 200 lines per file"
  outOfScope:
    - "Database migrations"
  maxRetries: 3
  feedback: ""       # populated on validation failure
  reworkCount: 0     # incremented on retry
```

**Lifecycle**: ready → in_progress → delivered → done (or failed → ready if retries remain)

**Context Passing**: Task `description` + `relatedFiles` serve as central reference. On failure, `feedback` + `reworkCount` passed back for iterative rework.

#### 5.2 Agent SOPs (Standard Operating Procedures)

Markdown-based instruction sets (from `strands-agents/agent-sop`):
- Step-by-step procedures with conditional branching
- Input/output specifications per step
- Error handling instructions
- Verification checkpoints

#### 5.3 OpenAI Agents SDK — Handoff Patterns

Two orchestration paradigms:

| Pattern | Mechanism | Use Case |
|---------|-----------|----------|
| **Agents as Tools** | Manager invokes specialists via `Agent.as_tool()` | One agent owns final answer, combines outputs |
| **Handoffs** | Triage agent routes conversation to specialist (becomes active) | Specialist should respond directly, prompts need focus |

Code-driven patterns:
- **Structured dispatch**: Classify → route to agent
- **Sequential chain**: Output of A → input of B
- **Eval loop**: Worker + Evaluator in while-loop
- **Parallel execution**: `asyncio.gather` for independent agents

#### 5.4 Structured Delegation Schema (Proposed for Octopus)

```yaml
delegation_request:
  from_agent: "orchestrator"
  to_agent: "researcher"
  task_id: "uuid"
  context:
    goal: "Research X and produce findings"
    background: "Previous work established Y"
    constraints: ["Max 2000 words", "Cite sources"]
  input_schema:
    type: object
    properties:
      query: { type: string }
      depth: { type: string, enum: [shallow, medium, deep] }
  output_schema:
    type: object
    required: [findings, sources, confidence]
    properties:
      findings: { type: string }
      sources: { type: array, items: { type: string } }
      confidence: { type: number, min: 0, max: 1 }
  sop: "research-standard-v1"
  timeout: 300s
  on_failure: retry(2) | escalate
```

---

### 6. State Transfer Between Orchestrator and Delegated Agent

**Sources**: [LangGraph State Management](https://eastondev.com/blog/en/posts/ai/20260424-langgraph-agent-architecture/) · [LangChain Multi-Agent Architecture](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture)

#### 6.1 LangGraph: Shared State via TypedDict/Pydantic

- **StateGraph**: All nodes access a unified state object
- State defined via `TypedDict` or Pydantic (preferred for validation)
- **Incremental updates**: Nodes modify specific attributes, not replace entire state
- **Reducers**: Custom merge logic for concurrent node updates (e.g., message lists)
- **Conversation history**: Built-in `add_messages` reducer with deduplication
- **Thread isolation**: Unique thread IDs prevent conversation bleeding
- **Checkpointing**: Automatic state snapshots; in-memory for dev, PostgreSQL for production
- **Sub-graphs**: Modular graphs operating as standalone engines within parent graph

#### 6.2 LangGraph Multi-Agent Handoff Patterns

- **Supervisor pattern**: Central node routes to specialist agents, receives results
- **Full history transfer**: Complete message list passes with each handoff
- **Trimmed history**: Limit to last *n* messages to avoid token overflow
- **State channels**: Different state fields for different concerns (messages, context, errors)

#### 6.3 CrewAI: Task Chaining + Tool Delegation

- **Sequential**: Task outputs concatenated as input context for next task
- **Hierarchical**: Manager agent delegates to specialists
- **Delegation mechanism**: `allow_delegation=True` wraps other agents as callable tools
- **Context injection**: Upstream task outputs (Pydantic models) flow into downstream tasks via handoff channels
- **Memory types**: Short-term (within task), Long-term (across tasks), Entity (per-subject)

#### 6.4 AutoGen/AG2: Conversation as State

- **Conversable agents**: Everything modeled as inter-agent conversation
- **Conversation patterns**: Two-Agent Chat, Sequential Chat, Group Chat, Nested Chat
- **Async messaging**: Agents communicate via async messages
- **Group chat orchestration**: Turn-taking, speaker selection, termination conditions
- **Shared state**: Conversation history IS the state; agents read full transcript

#### 6.5 State Transfer Taxonomy

| Concern | LangGraph | CrewAI | AutoGen | Octopus (current) |
|---------|-----------|--------|---------|-------------------|
| Conversation history | MessagesState (trimmed list) | Memory (short/long/entity) | Full conversation transcript | `$last_output` + VarPool |
| Working memory | TypedDict/Pydantic state | Task context object | Agent memory | VarPool (`$vars`) |
| Execution context | Checkpoints + thread ID | Crew execution state | Conversation state | ExecutionLifecycle + SQLite |
| Result passing | State reducers | Pydantic handoff objects | Message reply | `$node-id.output.xxx` |
| Persistence | PostgreSQL/in-memory | Database | Minimal | SQLite + JSONL |

#### 6.6 Recommended State Transfer Protocol for Octopus

```
DelegationContext {
  // Identity
  delegationId: string
  parentTaskId: string
  parentAgentId: string
  childAgentId: string

  // Task specification
  goal: string
  constraints: string[]
  sopRef?: string

  // Working memory snapshot
  varPoolSnapshot: Record<string, any>    // relevant $vars subset
  nodeOutputs: Record<string, any>        // relevant upstream outputs

  // Conversation history (trimmed)
  recentMessages: Message[]               // last N relevant turns
  summaryContext?: string                 // compressed earlier history

  // Result contract
  outputSchema: JSONSchema
  validationCommands?: string[]

  // Execution parameters
  timeout: number
  maxRetries: number
  onFailure: 'retry' | 'escalate' | 'fallback'
}
```

---

### 7. Modern Framework Implementations

#### 7.1 CrewAI — Role-Based Delegation

**Sources**: [CrewAI Docs](https://docs.crewai.com/v1.15.5/en/concepts/collaboration) · [A2A Integration](https://docs.crewai.com/v1.15.10/en/learn/a2a-agent-delegation)

- **Core concept**: Crew = team of agents with roles, goals, and tools
- **Delegation**: `allow_delegation=True` → other agents become callable tools
- **Process modes**: Sequential (chain), Hierarchical (manager delegates), Consensual (collaborative)
- **Task flow**: Task(description, expected_output, agent, context) → execution → typed result → next task
- **Memory system**: Short-term (current task), Long-term (persistent), Entity (per-subject), User (per-user)
- **A2A integration**: First-class support for Google A2A protocol as delegation primitive
- **Limitation noted**: Delegating agent doesn't regain control to review delegated task results

#### 7.2 LangGraph — Graph-Based State Machines

**Sources**: [LangGraph Docs](https://docs.langchain.com/oss/python/langgraph/graph-api) · [Multi-Agent Patterns](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture)

- **Core concept**: StateGraph with nodes (functions) and edges (conditional routing)
- **State**: Shared TypedDict/Pydantic object, incrementally updated by nodes
- **Message passing**: Nodes send messages along edges upon completion
- **Multi-agent patterns**:
  - **Supervisor**: Central router node → specialist agent nodes
  - **Hierarchical**: Supervisor of supervisors
  - **Collaborative**: Agents as nodes in a shared graph
- **Persistence**: Automatic checkpointing, thread-based isolation, PostgreSQL backend
- **Human-in-the-loop**: Interrupt nodes, approve/reject gates
- **Strength**: Retries, resumable checkpoints, complex state management
- **Weakness**: More centralized control, steeper learning curve

#### 7.3 AutoGen/AG2 — Conversation-Centric

**Sources**: [AutoGen Docs](https://microsoft.github.io/autogen/0.2/docs/Use-Cases/agent_chat/) · [AG2 Orchestration](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/patterns/)

- **Core concept**: Conversable agents that solve tasks through conversation
- **Agent types**: AssistantAgent (LLM-powered), UserProxyAgent (human/code execution)
- **Conversation patterns**:
  - **Two-Agent Chat**: 1:1 conversation loop
  - **Sequential Chat**: Chain of two-agent conversations, context carries forward
  - **Group Chat**: Multi-agent with speaker selection (round-robin, random, LLM-chosen, custom)
  - **Nested Chat**: Sub-conversations within conversations
- **Orchestration**: GroupChatManager controls turn-taking and termination
- **Async messaging**: Event-driven message passing between agents
- **Code execution**: Integrated code executor for agent-generated code
- **Cost**: 5–6x more expensive per task vs LangGraph (benchmark data)

#### 7.4 OpenAI Agents SDK — Handoffs + Tools

**Sources**: [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/)

- **Two paradigms**: LLM-driven (model decides routing) vs Code-driven (program controls flow)
- **Handoffs**: Triage agent → specialist (specialist becomes active agent for the turn)
- **Agents as Tools**: Manager invokes specialist via `Agent.as_tool()` without losing control
- **Composability**: Handoff recipient can itself invoke other agents as tools
- **Guardrails**: Enforced at manager level when using agents-as-tools pattern

#### 7.5 Framework Comparison Matrix

| Dimension | CrewAI | LangGraph | AutoGen/AG2 | OpenAI Agents |
|-----------|--------|-----------|-------------|---------------|
| **Communication model** | Tool-based delegation | Shared state graph | Conversation | Handoff + Tool |
| **Orchestration** | Auto (role-based) | Explicit (graph edges) | Conversational | LLM or code-driven |
| **State management** | Task context chain | TypedDict + checkpoints | Conversation history | Run context |
| **Delegation** | `allow_delegation` | Sub-graph invocation | Nested chat | Handoff / as_tool |
| **Persistence** | Memory system | PostgreSQL checkpoints | Minimal | Run state |
| **Best for** | Role-based teams | Complex workflows | Research/exploration | Production apps |
| **A2A support** | Yes (native) | Via integration | Not yet | Not yet |

---

### 8. Synthesis: Protocol Layer Recommendations for Octopus

Based on the research, here is a layered protocol stack recommendation:

```
┌─────────────────────────────────────────────────────┐
│  Layer 5: External Agent Interop                    │
│  → Google A2A Protocol (Agent Cards, Task lifecycle)│
├─────────────────────────────────────────────────────┤
│  Layer 4: Tool & Resource Integration               │
│  → MCP (Model Context Protocol)                     │
├─────────────────────────────────────────────────────┤
│  Layer 3: Delegation Protocol                       │
│  → Structured contracts (input/output schema,       │
│    SOP ref, constraints, retry policy)              │
├─────────────────────────────────────────────────────┤
│  Layer 2: Message Passing                           │
│  → Request/Response (delegation)                    │
│  → Pub/Sub (SSE events, lifecycle)                  │
│  → Blackboard (VarPool shared state)                │
├─────────────────────────────────────────────────────┤
│  Layer 1: State Transfer                            │
│  → DelegationContext (varPool snapshot,             │
│    node outputs, trimmed history, output schema)    │
└─────────────────────────────────────────────────────┘
```

**Key decisions**:
1. **Adopt A2A Agent Cards** for external agent discovery (future-proofing)
2. **Keep MCP** for tool/resource integration (already in use)
3. **Define Octopus Delegation Protocol** with structured contracts (inspired by Brainfile + FIPA performatives)
4. **Use message intent taxonomy** from FIPA (request, inform, propose, agree, refuse) as lightweight metadata
5. **Implement DelegationContext** for state transfer (inspired by LangGraph state model)
6. **Leverage existing VarPool** as blackboard for shared working memory
7. **Use SSE/pub-sub** for delegation lifecycle events (working, completed, input_required)

---

### Sources

**Primary Specifications**:
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [MCP Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18)
- [FIPA ACL Message Structure (FIPA00061)](https://www.fipa.org/specs/fipa00061/SC00061G.html)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)

**Framework Documentation**:
- [CrewAI Collaboration Docs](https://docs.crewai.com/v1.15.5/en/concepts/collaboration)
- [CrewAI A2A Delegation](https://docs.crewai.com/v1.15.10/en/learn/a2a-agent-delegation)
- [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [AutoGen Agent Chat](https://microsoft.github.io/autogen/0.2/docs/Use-Cases/agent_chat/)
- [AG2 Orchestration Patterns](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/patterns/)
- [OpenAI Agents SDK Multi-Agent](https://openai.github.io/openai-agents-python/multi_agent/)

**Architectural Analysis**:
- [Survey of Agent Interoperability Protocols (arXiv 2505.02279)](https://arxiv.org/html/2505.02279v1)
- [Agentic AI Frameworks Survey (arXiv 2508.10146)](https://arxiv.org/html/2508.10146v1)
- [Multi-Agent Architecture Guide (Openlayer, Mar 2026)](https://www.openlayer.com/blog/post/multi-agent-system-architecture-guide)
- [LangGraph State Architecture](https://eastondev.com/blog/en/posts/ai/20260424-langgraph-agent-architecture/)

**Patterns & Contracts**:
- [Brainfile Agent Contracts](https://brainfile.md/guides/contracts)
- [Agent SOPs (strands-agents)](https://github.com/strands-agents/agent-sop)
- [Multi-Agent Task Handoff](https://tpiros.dev/blog/multi-agent-systems-and-task-handoff/)
- [AI Agent Delegation Patterns](https://fast.io/resources/ai-agent-delegation-patterns/)
- [Blackboard Architecture in Agentic AI](https://data-flair.training/blogs/blackboard-architecture-in-agentic-ai/)
- [Tuple Spaces (Linda)](https://www.croftpress.com/david/research/agent/tuplespaces/)

**Messaging Patterns**:
- [Azure Pub/Sub Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/publisher-subscriber)
- [Pub/Sub in AI Agent Communication (LinkedIn)](https://www.linkedin.com/pulse/publish-subscribe-model-ai-agent-communication-rohan-prasad-mnbne)
- [Agent Communication Message Formats](https://mbrenndoerfer.com/writing/communication-between-agents)
- [Choosing the Right Multi-Agent Architecture (LangChain)](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture)
