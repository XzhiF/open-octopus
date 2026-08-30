# Open Octopus -(Adding "Open" just makes it feel more legit)

**English** | [中文](README.md)

> Agentic Workflow Orchestration + Multi-Project Isolation + Agent/Skill Asset Management + Task Board

> ⚠️ **Early Stage**: Octopus is under active development. Many features are being refined and generalized. APIs and workflow formats may change. Feedback is welcome, but not recommended for production use yet.

> 💬 The entire project was born from vibe coding — starting with real pain points at work, solving them with AI-assisted programming, borrowing ideas from those who came before, and building things step by step. The design may not be clever, but every core feature was forced into existence by real-world needs. Hope it helps others walking the same path.

## Introduction

Octopus aims to be a **Loop Engineering** development platform: AI Agents iterate continuously inside isolated multi-project environments through orchestratable workflows — and the project itself is iterated with Octopus.

Core idea: **an Agent is not a passive node in a workflow — it's a first-class citizen** that makes its own decisions, spawns sub-workflows dynamically, triggers multi-agent collaboration, and keeps running 24/7 under a safety harness. The system forms a self-iterating loop: *define → schedule → execute → guard → archive → evolve*.

- **Workflow Engine** — Declarative YAML DSL, 12 node types, dependencies auto-derived into a parallel DAG; Chain / DAG / Swarm / Dynamic orchestration
- **Swarm Engine** — Five strategies: review / debate / dispatch / dynamic / moa — one node orchestrates a panel of experts
- **Harness** — Three-layer safety guard (detect → intervene → delegate) that makes unattended runs actually trustworthy
- **Task Board + Scheduler** — Co-author Specs on a Kanban board, confirm to enqueue; cron-scheduled or manually triggered, self-looping 24/7
- **Workspace Isolation** — Per-project git worktrees with their own ports and databases — parallel without interference
- **Agent Clones** — Six built-in system clones each with a job of their own, plus custom ones; every clone carries its persona, skills, memory, and worktree, and can be versioned and merged back to the mainline
- **Asset Ecosystem** — 266 preset roles from agency-agents-zh plus the superpowers-zh skill library, with unified install / versioning / dependency management for Skills, Agents, and Workflows

---

## Tech Stack

TypeScript 5.9 · Node.js 20 · pnpm Workspaces · Hono 4 (REST + SSE + WebSocket) · Next.js 16 + React 19 · Claude Agent SDK + Pi Agent SDK · SQLite · XYFlow · Yjs · Monaco Editor · Zod · Vitest + Playwright

---

## Installation

```bash
git clone git@github.com:XzhiF/open-octopus.git
cd open-octopus
pnpm install
pnpm build
pnpm dev            # Web UI http://localhost:3000 · Server API http://localhost:3001
```

Before running, make sure you have **Node.js ≥ 20**, **pnpm ≥ 9**, **Git** (required for worktree isolation), and **Claude Code / Pi** as the AI execution engine. `gh` (GitHub CLI) is used for repository and PR operations, and Hermes for notification push — both optional.

> 🚧 Two things are in flight for the setup experience, and both will replace the steps above:
> 1. **Interactive setup wizard** — a first-run guide in the Web UI: pick an org, fill in the project manifest, install resources, all by clicking through
> 2. **Agent-friendly install doc** — a setup document you can hand straight to Claude Code, where *"get this running"* is enough to deploy and initialize everything

---

## Quick Start

Open http://localhost:3000:

1. **Initialize your org** — On first use, prepare `~/.octopus/orgs/<org>/repos/manifest.md` as your project list (currently via `octopus setup` + `octopus repos sync`; the setup wizard will replace this in one step)
2. **Create a Workspace** — Go to Workspace, click "New", pick a project and branch; each workspace owns a git worktree, port, and database
3. **Author workflows** — Write YAML in the Monaco editor, inspect node dependencies on the XYFlow canvas; pick from built-in templates or the resource library
4. **Run and observe** — Click Run and watch node status, expert discussion, logs, and token/cost spend in real time; anomalies are intercepted by Harness and pushed to you
5. **Task Board** — Co-author a Spec with an Agent (goal / acceptance criteria / bound workflow), confirm to enqueue, and let the Scheduler dispatch it
6. **Accumulate and reuse** — Finished runs are archived as knowledge and injected into later workflows; Skills / Agents / Workflows are managed centrally in the resource library

<p align="center">
<img src="docs/imgs/workflow.jpg" alt="Workflow Execution UI" width="30%" /><img src="docs/imgs/swarm.jpg" alt="Swarm Multi-Agent Collaboration" width="30%" /><img src="docs/imgs/archive.jpg" alt="Archive" width="30%" />
</p>

---

## Architecture

```
octopus/
├── packages/
│   ├── shared/          ← @octopus/shared (Zod schemas + VarPool + Harness contracts + config)
│   ├── providers/       ← @octopus/providers (Claude SDK + Pi SDK engines + token/cost tracking)
│   ├── cli/             ← octopus (Commander.js CLI)
│   ├── engine/          ← @octopus/engine (12 executors + WorkflowEngine + Harness + Checkpoint)
│   ├── server/          ← @octopus/server (Hono REST + SSE + WebSocket/Yjs + Actuator)
│   ├── web-app/         ← @octopus/web-app (Next.js 16 + React 19 frontend)
│   └── core-pack/       ← @octopus/core-pack (skills / agents / workflow templates)
├── scripts/             ← Dev tools (dev.mjs, prod.mjs, branch-port.mjs)
├── pnpm-workspace.yaml
└── CLAUDE.md
```

```
Package dependencies:
shared ← providers ← engine ← cli / server
shared ← cli / server / web-app
core-pack ← cli / server
```

---

## Key Features

### Workflow Engine — 12 Node Types

| Executor | Description |
|----------|-------------|
| **bash / python** | Run shell commands and Python scripts |
| **agent** | Invoke AI agents with sub-agent delegation and skill loading (Claude SDK / Pi SDK) |
| **octopus_agent** | Native platform agent node with access to Octopus' own tools and resources |
| **interaction** | Human-in-the-loop node for conversational clarification and confirmation |
| **condition** | Conditional branching |
| **approval** | Human approval (supports Auto Answers for unattended runs) |
| **loop** | Loop iteration with Checkpoint recovery |
| **swarm** | Multi-agent collaboration (5 strategies) |
| **sub_workflow** | Nested sub-workflow |
| **dynamic_sub_workflow** | LLM generates a sub-DAG at runtime |
| **task_dispatch** | Composite task dispatch — files sub-tasks back into the Task Board |

Dependencies are auto-derived into a parallel DAG; lifecycle hooks wake an agent to handle failures or budget overruns; resources are declared and pre-installed so a workflow is ready the moment it runs.

```yaml
# Variable system: $vars.xxx global pool · $node-id.output.xxx upstream · $last_output · $iteration
```

### Swarm — 5 Collaboration Strategies

A single YAML node orchestrates multiple AI experts:

| Mode | Description | Use Case |
|------|-------------|----------|
| **review** | All experts run in parallel once, Host synthesizes | Code review, security audit |
| **debate** | Multi-round discussion + consensus detection with early exit; sliding-window context, old-round summary compression, token budget safety valve | Tech decisions, trade-off analysis |
| **dispatch** | DAG dependency scheduling (Kahn topological sort + cycle detection), parallel within levels, serial across levels, downstream skipped on upstream failure | Feature implementation, multi-step collaboration |
| **swarm** | SwarmRouter two-phase routing: keyword prefilter → LLM picks 2–5 experts and the collaboration mode | Smart routing, open-ended topics |
| **moa** | Full fan-out to all experts → Aggregator merges results, with a model fallback chain | High-quality output, multi-perspective synthesis |

```yaml
# Example: 3-expert tech stack debate
- id: decision
  type: swarm
  topic: "TypeScript vs Go for a 15-person team's backend API service"
  mode: debate
  rounds: 3
  consensus_threshold: 0.7
  experts:
    - role: typescript-advocate
      prompt: "Argue the advantages of TypeScript/Node.js"
    - role: go-advocate
      prompt: "Argue the advantages of Go"
    - role: platform-engineer
      prompt: "Evaluate from a neutral platform engineering perspective"
```

### Harness — Three-Layer Safety Guard

Unattended runs are only viable if something has your back when things go wrong. Harness sits on the execution path, so anomalies stop needing a human watching a screen:

```
Detect (5 anomaly detectors)
  deterministic_error · stupid_retry · model_mismatch · process_conflict · timeout_cascade
    ↓
Intervene (5 actions)
  inject_message to steer · retry_with_hint to change approach · switch_model
  pause with notification · abort to protect the host
    ↓
Delegate
  Complex cases go to the Harness Agent for analysis and disposition; block and alert if it cannot self-heal
```

On the host side, ToolInterceptor blocks dangerous tool calls, and process-group isolation with port / PID protection keeps child processes from killing the host. Policies are overridable per workspace from the System panel.

### Task Board + Scheduler

- **Task Board** — A Kanban board where users and Agents co-author Specs (goal / acceptance criteria / bound workflow / sub-unit breakdown); confirm to enqueue, and a workflow view tracks execution progress per task
- **Workflow binding** — A preset catalog maps task types to workflow templates plus `input_values`, with required-field validation before enqueueing
- **SchedulerEngine** — Scans and claims queued tasks, dispatching in Simple (execute directly) or Composite (coordinator spawns sub-tasks) mode, with cron scheduling, run history, and audit logs

### Agent Clone System

Workflow nodes are the *work*; clones are the *people*. A clone = persona (persona.md) + skills + its own memory + a dedicated git worktree + model config — a role you can cultivate over time:

| Built-in system clone | Responsibility | Memory |
|------|------|------|
| **workspace** Full-stack dev assistant | Read/edit project files, build/test/deploy, code review | shared |
| **scheduler** Scheduled task manager | cron job creation, status monitoring, retry on failure, run reports | isolated |
| **archive** Engineering analyst | Execution archival, experience extraction, structured analysis | shared |
| **resource** Resource operations expert | Discovery, install, and dependency handling for Skills / Agents / Workflows | isolated |
| **harness-agent** Workflow safety guard | Takes over complex anomalies delegated by Harness, then disposes or blocks | isolated |
| **task-author** Task spec author | Turns vague requirements into schedulable Specs via chat on the Task Board | isolated |

- **Custom clones** — A creation wizard sets persona, skill set, model, and tools; persona and resource files are editable live in the Monaco panel with autosave, built-ins included
- **Isolated execution** — Each clone binds its own worktree and branch, reading and writing memory under a shared / isolated scope, so many clones run in parallel without stepping on each other
- **Version management** — Releases snapshotted under semver `major.minor.patch[-alpha|beta|rc|stable]`, dual-written to DB and filesystem with compensating transactions; versions can be diffed (persona / config / skill add-remove) and rolled back in one click
- **Result merging** — Clone output goes back to the mainline through a merge review dialog, and merged content enters the knowledge base as a `clone_merge` source
- **Two invocation paths** — The main Agent reaches clones through the unified CLI/API entry via LLM tool delegation (nothing to wire up by hand), or the Web UI connects to a clone session directly (zero routing latency); inside workflows the `octopus_agent` node assigns work to a specific clone

### Workspace Multi-Project Isolation

Three fully isolated run modes that can be up at the same time:

| Mode | Command | Server | Web | Database | Use Case |
|------|---------|--------|-----|----------|----------|
| **dev (main repo)** | `pnpm dev` | 3001 | 3000 | `octopus.db` | Daily development |
| **dev (worktree)** | `pnpm dev` | hash | +1 | `octopus-{branch}.db` | Parallel branches |
| **prod** | `pnpm prod` | 3099 | 3098 | `octopus-prod.db` | Use Octopus to iterate on itself |

Each workspace = its own git worktree + pipeline.yaml + skills/agents config + Checkpoint + logs. Create one manually, or let the Scheduler rebuild a clean environment from the ProjectSpec every time, auto-generating instruction files and preset resources.

### Unattended Execution

- **Auto Answers** — Global + node-level preset answers; AI auto-responds to confirmations
- **Notify subsystem** — Node progress, budget alerts, failures, and Harness interventions all funnel through Hermes to Telegram/Slack/Webhook, graded by severity
- **Hooks** — `on_workflow_failure` / `on_complete` / `on_node_success` lifecycle hooks that can wake an agent to self-heal
- **Checkpoint** — Node / level / batch state persistence with TTL, resumable after interruption
- **Budget** — Unified token / cost (USD) / time accounting, with threshold-triggered hooks and alerts

### Assets & Memory

- **Resource** — Unified install, versioning, and dependency management for Skills / Agents / Workflows; workflows declare what they need and resources are bound intelligently, loaded on demand, resolved automatically
- **Knowledge store** — Runs and conversations are auto-mined into experience entries (rule / skill) → reviewed into the store → conflict-resolved → injected by scope → hit effectiveness fed back (a full knowledge base is its next major upgrade — see Evolution)
- **Agent Memory** — Session summaries with FTS retrieval, archived per clone and over time, queryable by clones and the Orchestrator
- **SystemPromptAssembler** — Seven priority levels with budget-aware truncation, so context is spent where it matters

---

## Development

```bash
pnpm install                # Install dependencies
pnpm build                  # Build all packages
pnpm dev                    # Start dev environment (auto-detects main repo/worktree)
pnpm prod                   # Production mode (fully isolated)
pnpm port                   # View port allocation
pnpm test                   # Run tests (Vitest)
```

---

## Acknowledgements

Octopus draws inspiration and builds upon the following excellent projects:

- **[Archon](https://github.com/coleam00/Archon)** — Core concepts and foundational implementation for workflow orchestration. Special thanks to Cole Medin for his open-source contributions.
- **[superpowers-zh](https://github.com/jnMetaCode/superpowers-zh)** — Chinese-enhanced skill framework providing 20+ out-of-the-box Skills for Octopus.
- **[agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh)** — Chinese Agent role library with hundreds of built-in roles for Swarm Router dynamic selection.
- **[Matt Pocock's skills](https://github.com/mattpocock/skills)** — The clarify → spec → tickets → implement engineering flow this project's own evolution follows.

Thanks to these authors for creating such excellent open-source projects.


---

## Evolution

A platform grown step by step from real pain points:

```
SKILL Helper
  └→ Goal: Create enterprise-grade SKILLs

Dev Workspace
  └→ Aggregate multi-project Git Worktree parallel development

Workflow
  └→ Long-running unattended tasks, multi-node orchestration (Agent / SubAgent / Skills)

Agent Swarm
  └→ Expert team parallel collaboration, efficiency boost

Remote: Notify & Watch & Exec
  └→ Notifications, monitoring, and remote execution via Hermes + Telegram

Scheduler
  └→ Self-looping foundations (bug-hunter / research-2-pr / idea-2-pr)

Orchestrator Agent
  └→ Global Agent + SKILL + knowledge base + avatars + memory

Memory
  └→ Workspace archival, workflow execution knowledge injection, Orchestrator Agent auto SKILL enhancement

Resource
  └→ Unified management of SKILL / Agent / Workflow installation, versioning,
     and dependencies; smart binding on workflow execution — load on demand,
     resolve automatically

Agent as First-class Node
  └→ The octopus_agent node puts platform agents directly inside workflows, tools,
     memory, and resources included; interaction and task_dispatch wire up the
     human loop and task delegation, with chat driving execution both ways

Knowledge Store
  └→ Lightweight per-entry accumulation: extract → review → conflict resolution →
     injection → effectiveness feedback, already covering archive / conversation /
     clone-merge sources

Harness
  └→ Three-layer safety guard: anomaly detection → smart intervention → agent
     delegation, plus ToolInterceptor and process-tree isolation, so unattended
     runs are finally safe to actually turn on

Workflow Observability
  └→ Actuator runtime endpoints + unified token/cost accounting + error tracing
     + execution monitoring

Task Board
  └→ Requirement → Spec (goal / acceptance criteria / workflow binding) → confirm
     and enqueue → scheduled execution → board tracking
```

**… In Progress ↓**

```
Task Board Hardening
  └→ Currently focused on task specification and execution modes: unified Spec field
     semantics, verifiable acceptance criteria, workflow binding with required-field
     validation, and both Simple / Composite execution paths smoothed out

Setup & Onboarding
  └→ Paying back the productization debt: an in-browser setup wizard plus an
     agent-friendly install doc, collapsing today's scattered CLI steps and
     hand-edited manifests into one repeatable onboarding
```

**… Planned ↓**

```
Second Brain · Full Knowledge Base
  └→ Not today's entry-level experience store, but a major version jump: a structured,
     complete knowledge base — unified cataloging and retrieval across projects,
     execution history, and conversations, with provenance, freshness, conflicts, and
     evolution chains — so every pitfall and decision sticks, comes back when searched,
     and gets used: a genuine second brain for the developer

Clone Dojo
  └→ Built on that knowledge base — training only makes sense once the accumulation is
     searchable: give clones somewhere to actually train, with samples (domain task sets
     and test cases) · evaluation (reproducible scoring and verdicts) · quantified data
     (capability radar and growth curves) · a training ground (isolated environment with
     re-runnable cases), plus domain-organized "manuals" (SKILLs + memory +
     counter-examples), so a clone built for a specific job advances with a venue, a
     syllabus, and scores to follow

Sandbox
  └→ An execution sandbox for end-to-end E2E — build, boot, browser interaction, and
     result assertion form a closed loop with no dependency on external deployment, so
     every delivery can actually be verified by running it

Hub-and-Spoke
  └→ Architecture evolution: centralized configuration management, coordinated
     scheduling, no longer single-machine bound
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
