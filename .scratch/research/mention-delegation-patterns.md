# @Mention Delegation: Industry Patterns for Sub-Agent Invocation in Chat

> Research compiled July 2026 — covers Claude Code, ChatGPT/Codex, Cursor, Windsurf/Devin Desktop, Microsoft Copilot, Slack, OpenCode, GitHub Copilot, AutoGen, CrewAI, LangGraph, and Swarms.

---

## 1. @Mention Syntax — What Platforms Use What

| Platform | Syntax | Example | Conflict Resolution |
|----------|--------|---------|-------------------|
| **ChatGPT (web)** | `@GPTName` | `@ResearchGPT analyze this paper` | Custom GPTs live in a separate namespace from user mentions — ChatGPT autocomplete shows GPTs only |
| **OpenCode CLI** | `@agent-name` | `@steward check this file` | Only agents are registered in the `@` namespace; users aren't mentionable |
| **Windsurf/Devin Desktop** | `@skill-name` | `@code-reviewer review my changes` | Skills are defined in `.windsurf/skills/` — no user namespace exists |
| **Cursor** | No native `@` for agents | Uses agent mode, background agents, and `.cursor/rules/` | N/A — Cursor uses mode switching, not `@` |
| **GitHub Copilot (VS Code)** | `#runSubagent` | `#runSubagent analyze test coverage` | Uses `#` prefix to avoid conflict with `@` user mentions |
| **Slack bots** | `@BotName` | `@SalesBot what's the Q3 forecast?` | Each bot is a separate Slack app — one app per agent; platform-level routing |
| **Microsoft Copilot Studio** | No `@` syntax | Orchestration is config-driven (parent routes to child agents) | Connected agents are registered by description, not by name |
| **Discord (multi-agent)** | `@BotName` | `@CodeReviewer check this PR` | Per-channel/per-category routing rules; "home lane" vs mention-required zones |
| **Swarms framework** | `@agent_name` | `@researcher find papers on X` | Agent-to-agent `@mention` within group chat; framework-level dispatch |
| **CrewAI** | No `@` syntax | Programmatic delegation via role names | Hierarchical process manager assigns tasks by role |
| **AutoGen (AG2)** | No `@` syntax | Conversational turn-taking; agents are "participants" | Structured chat with defined speaker order |
| **LangGraph** | No `@` syntax | Graph-based routing via nodes/edges | Explicit state machine; no mention syntax at all |

### Key Insight: The `@` vs User Mention Conflict

The industry has **three strategies** for avoiding conflicts between agent `@mentions` and regular user `@mentions`:

1. **Separate namespaces** (ChatGPT, Slack): Agents/bots live in their own autocomplete namespace. When you type `@`, the UI shows agents separately from users. Slack solves this at the platform level — each bot is a separate Slack app with its own identity.

2. **Different prefix** (GitHub Copilot): Uses `#` prefix (`#runSubagent`) to explicitly distinguish agent invocation from user mentions.

3. **No user namespace** (OpenCode, Windsurf): These are single-user dev tools where `@` only ever refers to agents/skills, so no conflict exists.

4. **Per-channel routing rules** (Discord/Hermes Agent): Agents respond freely in their "home" channel but require explicit `@mention` in shared channels. This is the **home-lane pattern** — each agent has a zone where it responds without being mentioned, and requires `@` elsewhere.

---

## 2. Delegation Mechanism — Where Does the Routing Happen?

### Pattern A: Frontend Parses, Routes to Different Endpoint

| Platform | How it works |
|----------|-------------|
| **ChatGPT** | Frontend detects `@GPTName`, shows autocomplete dropdown, routes the message to the named GPT's conversation thread. The mention is resolved before the message reaches any LLM. |
| **Slack** | Platform-level routing. When you `@BotName`, Slack's event system delivers the message only to that bot's registered endpoint. The mention is resolved at the infrastructure layer, not by any LLM. |
| **Discord** | Similar to Slack — the Discord gateway delivers messages to bots based on `@mention` in the message payload. Each bot's code checks whether it was mentioned. |

### Pattern B: Current Agent Detects Mention, Delegates via Tool Call

| Platform | How it works |
|----------|-------------|
| **Claude Code** | The parent agent has an `Agent` tool (with `subagent_type` parameter). When the parent's reasoning identifies a task suitable for delegation, it calls the Agent tool. There is no user-facing `@mention` — the LLM decides to delegate based on its system prompt and task decomposition. The subagent runs in an **isolated context window** and returns a summary. |
| **GitHub Copilot (VS Code)** | The user writes `#runSubagent` in their prompt. The Copilot orchestrator parses this and invokes a sub-agent as an isolated tool call. The sub-agent receives only the explicitly provided context, not the full conversation. |
| **Windsurf/Devin Desktop** | User types `@skill-name` in Cascade input. Cascade either auto-detects the need for a skill or the user explicitly invokes it. The skill content is loaded from `.windsurf/skills/SKILL.md` and executed as a focused sub-task. |

### Pattern C: Backend Intercepts Before LLM

| Platform | How it works |
|----------|-------------|
| **Microsoft Copilot Studio** | The parent orchestrator uses intent classification to match user queries to connected agents. The routing decision happens at the orchestration layer (before the child agent's LLM processes the message). The parent's configuration includes agent descriptions that drive routing. |
| **OpenAI Agents SDK (Handoffs)** | The agent's tool definition includes handoff targets. When the agent's reasoning decides to hand off, it calls a handoff function. The **delegated agent receives the full conversation history** and takes over the conversation entirely. |

### Pattern D: Programmatic Routing (No Mention Syntax)

| Platform | How it works |
|----------|-------------|
| **CrewAI** | Hierarchical delegation — a "manager" agent decomposes tasks and assigns them to workers by role name. No `@` syntax; routing is defined in the crew configuration. |
| **LangGraph** | Graph nodes represent agents. Routing is explicit state transitions defined in code. No mention syntax — the graph structure determines which agent runs when. |
| **AutoGen (AG2)** | Agents are participants in a structured conversation. Turn-taking rules determine who speaks when. Delegation happens through conversational messages, not tool calls. |

### Summary: The Three Routing Architectures

```
┌─────────────────────────────────────────────────────────────┐
│  1. FRONTEND ROUTING (ChatGPT, Slack, Discord)              │
│     User @mentions → UI resolves → routes to agent endpoint │
│     LLM never sees the @mention as text                     │
├─────────────────────────────────────────────────────────────┤
│  2. AGENT-LEVEL ROUTING (Claude Code, Copilot, Windsurf)    │
│     User message → LLM receives it → LLM calls Agent tool   │
│     Sub-agent runs in isolated context, returns summary     │
├─────────────────────────────────────────────────────────────┤
│  3. ORCHESTRATOR ROUTING (Copilot Studio, Agents SDK)       │
│     User message → orchestrator classifies intent → routes  │
│     to child agent with context handoff                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Context Passing — What Does the Sub-Agent See?

| Platform | Context Strategy | Details |
|----------|-----------------|---------|
| **Claude Code** | **Isolated context window** | Sub-agent starts fresh. Parent provides task description + relevant file paths. Sub-agent does NOT inherit conversation history. Returns a 750-token summary. Results in **90%+ token reduction** vs passing full context. |
| **OpenAI Agents SDK (Handoffs)** | **Full conversation history** | When a handoff occurs, the delegated agent receives the entire conversation history and takes over. This is the opposite extreme from Claude Code. |
| **GitHub Copilot** | **Explicit context only** | Sub-agent receives only what the parent explicitly passes. Completely unaware of broader discussion. |
| **Microsoft Copilot Studio** | **Conversation history + parameters** | By default, passes conversation history. Parent can also pass specific parameters (e.g., user's name) to avoid re-asking. Configurable per handoff. |
| **Windsurf/Devin Desktop** | **Clean slate per sub-agent** | Each sub-agent starts with no inherited history. The parent's task description and relevant file context are the only inputs. |
| **ChatGPT (Codex subagents)** | **Scoped task context** | Sub-agents get the task description and relevant code context. Not the full conversation. Each runs as a "child session." |
| **Swarms framework** | **Configurable** | Agents in GroupChat can see prior messages from other agents. Context sharing is configurable per swarm type. |
| **LangGraph** | **Shared state** | All agents read from and write to a shared state object. Context passing is explicit state mutations, not message history. |
| **AutoGen** | **Full group chat history** | All agents in a conversation see all prior messages. Context is the accumulated chat transcript. |
| **CrewAI** | **Task-scoped context** | Workers receive the task description + any context the manager explicitly provides. The crew's shared memory can be optionally included. |

### The Context Spectrum

```
Minimal Context ◄─────────────────────────────────► Full Context
(GitHub Copilot,     (Copilot Studio,    (OpenAI Handoffs,
 Claude Code,         configurable)       AutoGen GroupChat)
 Windsurf)
 
     Task description     Conversation history     Everything
     + relevant files     + explicit params        + shared state
```

### Key Insight: The "Context Compression" Pattern

The dominant pattern in 2026 is **context compression** — sub-agents run in isolation, do heavy work (read 8 files, make 15 tool calls), but return only a concise summary to the parent. This keeps the parent's context window lean for longer conversations. Claude Code pioneered this and it has been widely adopted.

---

## 4. Response Integration — How Is the Sub-Agent's Response Shown?

| Platform | Display Pattern | Details |
|----------|----------------|---------|
| **Claude Code** | **Inline in same chat, as tool result** | Sub-agent output appears as a collapsed/expandable section within the parent's response. The parent integrates findings into its own reply. |
| **ChatGPT (web)** | **Separate conversation thread** | `@GPTName` opens/routes to a separate conversation with that GPT. Results appear in that GPT's chat. |
| **ChatGPT (Codex)** | **Child sessions** | Sub-agents run in separate "child sessions." Users navigate between parent and child sessions using keybindings (`session_child_first`, `session_parent`). |
| **GitHub Copilot (VS Code)** | **Inline, expandable** | Sub-agent's tool calls and responses appear inline beneath the parent action, collapsible. |
| **Microsoft Copilot Studio** | **Single unified response** | Best practice: "Only the parent agent talks to the user." Sub-agents return findings to the parent, which synthesizes a single response. Sub-agents must NEVER reply to the user directly. |
| **Windsurf/Devin Desktop** | **Agent Command Center (Kanban)** | Each agent session appears as a card in a Kanban-style view. Agent outputs are filterable independently. Parallel agents show side-by-side. |
| **Slack** | **Inline in chat** | Bot responses appear as messages in the same channel, attributed to the bot's identity (avatar + name). |
| **Discord** | **Inline in chat** | Bot responses appear as messages from the bot user. Thread-based organization is common. |
| **OpenCode CLI** | **Child sessions in terminal** | Sub-agent output is in a separate session panel. Users navigate with keybindings. |
| **Swarms** | **Group chat transcript** | Each agent's response appears as a message from that agent in the shared chat. |
| **AutoGen** | **Sequential messages** | Each agent's output is a message in the group chat, attributed by role name. |

### The Four Response Integration Patterns

1. **Synthesized Single Response** (Copilot Studio, Claude Code)
   - Parent agent collects all sub-agent outputs
   - Synthesizes into one unified response
   - Sub-agents are explicitly told "NEVER reply to the user directly"
   - Best for: enterprise, customer-facing scenarios

2. **Attributed Inline Messages** (Slack, Discord, Swarms, AutoGen)
   - Each sub-agent's response appears inline with attribution (bot name/avatar)
   - Users see which agent said what
   - Best for: collaborative team scenarios

3. **Separate Sessions/Panels** (ChatGPT Codex, OpenCode, Windsurf)
   - Sub-agents run in isolated sessions/panels
   - Users navigate between parent and child views
   - Best for: developer tools, parallel task management

4. **Collapsible Tool Results** (Claude Code, GitHub Copilot)
   - Sub-agent output appears as an expandable/collapsible section
   - Default view shows summary; expand for full output
   - Best for: keeping the main conversation clean

---

## 5. Practical Implementation Patterns (for Octopus)

Based on the research, here are the patterns most applicable to Octopus's chat-based agent delegation:

### Recommended Architecture: Hybrid Frontend + Agent-Level Routing

```
User types: "Hey @code-reviewer check my latest changes"
                    │
                    ▼
        ┌───────────────────────┐
        │  Frontend Parser      │  Detects @code-reviewer
        │  (regex/triggers)     │  Resolves to agent definition
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  Orchestrator Layer   │  Decides routing strategy:
        │  (backend)            │  - Inline delegation (current agent 
        │                       │    detects + delegates via tool)
        │                       │  - Direct routing (bypass current 
        │                       │    agent, route to target)
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  Sub-Agent Execution  │  Isolated context window
        │  (Agent tool call)    │  Task description + relevant context
        │                       │  Returns summary
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  Response Integration │  Show as attributed message block
        │  (UI rendering)       │  with agent name/avatar
        │                       │  Collapsible for detail
        └───────────────────────┘
```

### Decision Matrix for Octopus

| Question | Recommended Choice | Rationale |
|----------|-------------------|-----------|
| **@mention syntax** | `@agent-name` (single `@`) | Industry standard. Avoid `@@` — no major platform uses it. Resolve conflicts by maintaining a separate agent registry namespace. |
| **Conflict resolution** | Agent registry lookup | When user types `@`, autocomplete shows registered agents/skills only. If no match, treat as regular text. |
| **Delegation layer** | Agent-level (LLM tool call) | Most flexible. Lets the parent agent decide whether to delegate, add context, or handle directly. Frontend just highlights the mention. |
| **Context passing** | Task-scoped + conversation summary | Pass: (1) the current message, (2) a summary of recent conversation, (3) relevant file/code context. NOT full history (too noisy). |
| **Response display** | Attributed inline block + collapsible | Show sub-agent's response as a distinct message block with agent name/avatar. Collapsible detail section. Parent can add synthesis above. |
| **Parallel sub-agents** | Yes, with session panel | Follow Windsurf's Agent Command Center pattern — show parallel agents as cards/panels. |

### The "Single Response Principle" (from Microsoft Copilot Studio)

This is the most important best practice from the research:

> **"Ensure only one agent talks to the user per turn."**
> 
> - Add to parent instructions: *"You're the only agent that communicates with the user. Combine findings from all child agents into a single response."*
> - Add to every sub-agent's instructions: *"You're a subagent. Do NOT reply to the user directly. Your job is to search for information and return your findings to the parent agent."*

This prevents duplicate/partial messages and keeps the conversation coherent.

---

## 6. Platform-Specific Deep Dives

### Claude Code — Sub-Agent Architecture

- **Invocation**: Parent agent calls the `Agent` tool with `subagent_type` parameter
- **Isolation**: Each sub-agent gets its own context window, tool budget, and permissions
- **Dynamic Workflows** (June 2026): Lead agent can fan out hundreds of parallel sub-agents
- **Context Compression**: Sub-agent reads files, runs tools, but returns only a ~750-token summary
- **Three patterns**: Explore (research), Plan (architecture), Execute (implementation)
- **No user-facing @mention**: The LLM autonomously decides when to delegate

### ChatGPT/Codex — GPT Mention + Subagents

- **User-facing @mention**: `@GPTName` in ChatGPT web routes to that Custom GPT
- **Codex subagents**: Spawned automatically by the parent agent for parallel work
- **Child sessions**: Users navigate between parent and child sessions
- **Skills**: Invoked with `$skillname` syntax (separate from `@` for agents)

### Microsoft Copilot Studio — Enterprise Multi-Agent

- **Two agent types**: Inline agents (child workflows, shared context) vs Connected agents (separate orchestration, own tools/knowledge)
- **Data handoff**: Configurable — conversation history passed by default, plus explicit parameters
- **Security boundary**: Connected agents may have different privileges; parent must not bypass restrictions
- **9 best practices**: Single response principle, subagent role declaration, directive language, non-overlapping knowledge sources, distinct descriptions, explicit orchestration patterns, task delegation with "no direct reply", domain-mismatch testing, ask-vs-inform distinction

### Windsurf/Devin Desktop — Agent Command Center

- **Cascade**: Main AI agent in the IDE
- **Skills**: Defined in `SKILL.md` files, invoked via `@skill-name` or auto-detected
- **Windsurf 2.0**: Agent Command Center (Kanban view), Devin cloud delegation, Spaces, Fast Context Sub-Agent (SWE-grep, 20x faster)
- **Parallel agents**: Multiple Cascade agents using Git worktrees, each on isolated branches

### Slack — Agent Orchestration

- **Slackbot as hub**: Routes agents, pulls context, automates work
- **Universal router**: Recognizes full internal software inventory, sends assignments to right agent
- **One bot per agent**: Clean approach for separately addressable agents in one channel
- **SlackAgents** (research paper): Scalable multi-agent collaboration within Slack workspaces

### Multi-Agent Frameworks (AutoGen, CrewAI, LangGraph)

| Framework | Delegation Model | Context | Response |
|-----------|-----------------|---------|----------|
| **AutoGen/AG2** | Conversational — agents negotiate in structured chats | Full group history | Sequential messages in group chat |
| **CrewAI** | Hierarchical — manager assigns tasks by role | Task-scoped + shared memory | Attributed messages |
| **LangGraph** | Graph-based — nodes/edges with explicit state | Shared state object | State mutations |

---

## Sources

- [Claude Code Agent Teams, Subagents, and MCP: The 2026 Guide](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026)
- [Claude Code Features – 2026 Q2](https://wal.sh/research/2026-q2-claude-code-features/)
- [Multi-agent | OpenAI API](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- [Subagents | ChatGPT Learn](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI Agents SDK — Handoffs](https://openai.github.io/openai-agents-python/agents/)
- [Multi-agent orchestration patterns — Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns)
- [Orchestration Patterns for Multi-Agent Systems — Microsoft DevBlogs](https://devblogs.microsoft.com/ise/coordinator-patterns-multi-agent-systems/)
- [Agent Orchestration & Cowork with Slackbot — Slack Blog](https://slack.com/blog/news/agent-orchestration)
- [SlackAgents: Scalable Collaboration (ACL)](https://aclanthology.org/2025.emnlp-demos.76.pdf)
- [OpenCode Agents Documentation](https://opencode.ai/docs/agents/)
- [Windsurf 2.0 — Devin Blog](https://devin.ai/blog/windsurf-2-0/)
- [Windsurf Wave 13: Multi-Agent Coding](https://www.joinnextdev.com/blog/windsurf-wave-13-multi-agent-coding-is-here-now)
- [Three Sub-Agent Patterns — Inngest](https://www.inngest.com/blog/three-patterns-you-need-for-agentic-systems)
- [AI Sub-Agent Patterns — Epsilla](https://www.epsilla.com/blogs/2026-03-14-ai-sub-agent-patterns)
- [VS Code Unified Agent Experience](https://code.visualstudio.com/blogs/2025/11/03/unified-agent-experience)
- [LangGraph vs CrewAI vs AutoGen 2026](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63)
- [AI Agent Delegation Patterns — fast.io](https://fast.io/resources/ai-agent-delegation-patterns/)
- [Cursor Agent Best Practices](https://cursor.com/blog/agent-best-practices)
- [Sub-Agent Design Patterns — product-on-purpose/pm-skills](https://github.com/product-on-purpose/pm-skills)
- [Discord Agent Routing and @mention Priority](https://www.reddit.com/r/openclaw/comments/1sr8ec0/discord_agent_routing_and_mention_priority/)
- [Hermes Agent — Discord strict mention mode](https://github.com/NousResearch/hermes-agent/issues/20742)
- [Swarms GroupChat API](https://docs.swarms.world/api/group-chat)
- [Custom GPTs @ mention issue](https://community.openai.com/t/custom-gpts-no-longer-appear-when-using-after-today-s-interface-update/1384672)
