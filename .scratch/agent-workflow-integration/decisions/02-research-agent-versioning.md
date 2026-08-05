# 02 — Research: Agent Versioning & Release Management

Type: research
Status: resolved
Blocked by: None

## Question

What are industry patterns for versioning AI agent definitions (system prompts, tool configs, skills, personas)? Focus on:
- How platforms like LangSmith, CrewAI, Dify, Coze handle agent versioning
- Snapshot vs diff-based versioning approaches
- Version rollback and migration strategies
- How version changes propagate to running workflows
- Semantic versioning for agent configs vs freeform versioning
- A/B testing and canary deployment of agent versions

## Answer

### 1. Platform Comparison

#### LangChain Hub / LangSmith

- **Versioning model**: Git-like commit hash system. Every save creates an immutable commit identified by a unique hash (e.g., `12344e88`).
- **Pinning**: Applications pull prompts via `hub.pull("my-prompt:12344e88")` (commit hash) or `hub.pull("my-prompt:prod")` (tag). Pulling without a version specifier gets `latest`, which is a floating pointer — explicitly discouraged in production.
- **Tags & Environments**: Commit tags (`staging`, `prod`, custom) are movable labels pointing to specific commits. LangSmith provides built-in Environment promotion: assign any commit to Staging or Production, promote with a click, roll back with a click.
- **Rollback**: Reassign the environment tag to an older commit hash. Zero code change needed if the app pulls by tag.
- **GitHub sync**: Prompts can be synced to/from GitHub repositories via `prompt-commit`, enabling CI/CD integration and code-review workflows for prompt changes.
- **Scope**: Primarily focuses on prompt templates. Agent-level versioning (tools, persona, model) requires external orchestration.
- **Key insight**: The commit-hash model is the most mature pattern in the prompt-management space and directly maps to how Octopus could version agent definitions.

#### CrewAI

- **Versioning model**: Code-first. Agent definitions live in Python code as `Agent` class instances. Versioning relies on standard Git workflow — there is no built-in agent registry or version history UI.
- **CrewAI Enterprise**: Adds deployment management via CLI (`crew deploy`). Each deployment creates a versioned release, but the internal data model is opaque (closed-source).
- **Rollback**: Community discussions reveal no native rollback mechanism within the framework itself. Rollback means reverting Git commits and redeploying. CrewAI Enterprise deployments support version rollback at the deployment layer.
- **Key insight**: CrewAI's approach is "version your code, not your config." This works for monolithic agent setups but doesn't address the need for runtime agent config versioning that a platform like Octopus requires.

#### Dify

- **Versioning model**: Built-in version control for Chatflow and Workflow apps. Three states: `Current Draft` (unpublished edits), `Latest Version` (live), `Previous Versions` (historical releases).
- **Publishing flow**: Creator edits draft → clicks "Publish Update" → draft becomes a new version, new blank draft created. Each version gets an auto-generated title (filterable by author, with named versions).
- **Rollback**: "Restore a version" overwrites the active draft with an older iteration. The restored version must be re-published to go live. The active draft and live release cannot be deleted.
- **Storage**: Versions store a full DSL (Domain Specific Language) export of the workflow/agent configuration. The DSL can be exported for external inspection.
- **Limits**: Free tier executes only the latest publication. Paid plans add API execution of specific historical versions, DSL export, and restore.
- **Roadmap**: Advanced version control planned — extracting business SOPs from agent prompts into centrally managed, versioned resources ("edit once, apply everywhere").
- **Key insight**: Dify's draft → publish → restore model is the simplest and most user-friendly pattern. The DSL-export approach maps well to Octopus's YAML-based agent definitions.

#### Coze (ByteDance)

- **Versioning model**: App-level version management with archive, preview, and rollback. Each published version is an immutable snapshot.
- **States**: Draft (editing), Published (live), Archived (historical). The open API exposes version management endpoints (`/app/archive/versions`).
- **Rollback**: Restore any archived version to draft, then re-publish. Preview functionality allows testing a version before going live.
- **Recent evolution**: Coze 2.5 (April 2026) and Coze 3.0 (June 2026) introduced major platform updates, suggesting the versioning system is still evolving.
- **Key insight**: Coze's archive/preview/rollback model is similar to Dify but adds a preview step before publishing, which is useful for validation.

#### AutoGen (Microsoft)

- **Versioning model**: No built-in version management. Agent configs are Python code (`AssistantAgent`, `UserProxyAgent` classes). Versioning is entirely Git-based.
- **Migration**: As of April 2026, Microsoft released an official migration guide from AutoGen to the **Microsoft Agent Framework**, suggesting AutoGen is being superseded. The new framework may introduce platform-level version management.
- **Key insight**: AutoGen represents the "framework without platform" end of the spectrum — powerful for building agents but no opinion on how to version them. Octopus should avoid this gap.

### 2. Versioning Models: Snapshot vs Diff-Based

#### Industry Consensus: Snapshot Wins

Every major platform examined uses **snapshot-based versioning** (full copy per version) rather than diff-based storage. The reasons are well-documented:

| Factor | Snapshot | Diff-Based |
|--------|----------|------------|
| **Rollback complexity** | Trivial — restore the snapshot | Complex — must reconstruct from chain of diffs |
| **Audit trail** | Each version is self-contained and independently inspectable | Requires walking the diff chain |
| **Storage cost** | Higher, but agent configs are small (KBs, not GBs) | Lower, but savings are marginal for config-sized payloads |
| **Concurrency** | No merge conflicts — each version is independent | Diff chains create merge complexity |
| **Debugging** | Compare two complete snapshots side-by-side | Must mentally reconstruct state from diffs |
| **Compliance** | Regulators (EU AI Act) want "a version-controlled changelog" of complete states | Diff-only approaches may not satisfy audit requirements |

**Key finding from OpenLegion**: Agent manifests (comprehensive YAML records) should capture the entire configuration state — exact model snapshot, prompt hash, tool schemas, hand-off payload structures, and evaluation scores. The CI/CD pipeline auto-creates and commits manifests, satisfying regulatory needs.

**The one exception** is tool journals (append-only event logs) which complement snapshots by recording "why" something changed, not just "what" changed. This is useful for debugging but is a secondary system, not the primary versioning mechanism.

#### Storage Patterns for Snapshots

Three concrete database patterns observed:

1. **Row-Version Snapshots** (most common): Append-only table stores the full `before_json` and `after_json` of each versioned entity, keyed by `version_id`. Simple, cheap, and sufficient for config-sized payloads.
2. **Shadow Writes**: Proposed changes written to a staging table with status (`pending`, `approved`, `rejected`, `applied`). Useful when approval workflows are needed before changes go live.
3. **Copy-on-Write Environments**: Fork the entire environment for heavy operations. Overkill for agent config versioning but used by coding agents.

### 3. Data Model Patterns

#### Common Schema Elements

Across platforms, version history storage converges on these fields:

```
agent_versions:
  id:              uuid (primary key)
  agent_id:        uuid (FK to agents table)
  version_number:  integer (auto-incrementing per agent) OR semver string
  commit_hash:     string (immutable content hash)
  snapshot:        jsonb (full agent definition — prompt, tools, model, persona, skills)
  status:          enum (draft | published | archived)
  created_by:      uuid (FK to users)
  created_at:      timestamp
  published_at:    timestamp (nullable)
  release_notes:   text (nullable)
  parent_version:  uuid (nullable — which version this was derived from)
  environment:     enum (staging | production | null)
  tags:            text[] (custom labels)
```

#### Append-Only Log vs Separate Table

- **Separate versions table** (most common): `agents` holds current state; `agent_versions` holds history. The `agents` table has a `current_version_id` pointer. This is the pattern used by Dify, Coze, and LangSmith.
- **Append-only log** (less common for UI platforms, common for Git-backed systems): Every change is an immutable record. "Current state" is derived by reading the latest record. This is essentially how Git works and how LangSmith's commit-hash model maps conceptually.

#### Content-Addressable Hashing

OpenLegion recommends hashing the entire agent config into a content-addressable identifier (like Git's object model). Benefits:
- Deduplication: identical configs share one hash
- Integrity: any tampering changes the hash
- Cross-referencing: workflows can pin to a specific hash

### 4. Rollback Mechanisms

#### Pattern A: Pointer Reassignment (LangSmith, recommended)

Rollback = reassign the `production` tag/environment pointer to an older commit hash. No data changes, no redeployment needed if the runtime resolves by tag.

```
BEFORE:  prod → commit_abc123 (broken)
AFTER:   prod → commit_def456 (known-good)
```

**Advantages**: Instant, zero-downtime, no code change.
**Requirements**: Runtime must resolve agent references by tag/environment, not by hardcoded ID.

#### Pattern B: Restore-then-Republish (Dify, Coze)

Rollback = restore an older version to draft, review, then re-publish. This is a two-step process that forces human review before the rollback goes live.

**Advantages**: Safer — prevents accidental rollback to a bad version.
**Disadvantages**: Slower, requires manual intervention.

#### Pattern C: Git Revert (CrewAI, AutoGen, code-first platforms)

Rollback = `git revert` the commit that changed the agent config, then redeploy.

**Advantages**: Works with existing CI/CD tooling.
**Disadvantages**: Requires full deployment cycle; slowest rollback; merge conflicts possible.

#### Pattern D: Blue-Green / Canary Swap

Maintain two complete environments. Rollback = swap traffic routing from the new (broken) environment back to the old one.

**Advantages**: Zero-downtime, clean separation.
**Disadvantages**: Doubles infrastructure cost; overkill for config-only changes.

#### Recommendation for Octopus

Combine Pattern A (pointer reassignment) as the primary mechanism with Pattern B (restore-then-republish) as an option for cautious teams. The agent definition should be resolved at execution time via `agent_id + version_tag` (e.g., `agent:123@production`), allowing instant rollback by repointing the tag.

### 5. Version Propagation: Pinned vs Latest

#### The Core Tension

When an agent version changes, what happens to workflows that reference it?

| Strategy | Behavior | Risk | Use Case |
|----------|----------|------|----------|
| **Pin to version** | Workflow always uses the specific version it was built with | Stale — misses improvements and fixes | Production stability |
| **Follow latest** | Workflow always uses the newest published version | Breakage — untested versions go live | Development, experimentation |
| **Follow tag** | Workflow uses whatever version the tag points to | Moderate — tag promotion is controlled | Team-controlled promotion |
| **Follow semver range** | Workflow uses latest version matching a constraint (e.g., `^2.0`) | Controlled — only compatible updates | Managed evolution |

#### Industry Patterns

- **LangSmith**: Strongly recommends pinning to commit hashes in production. Tags (`prod`, `staging`) are the promotion mechanism.
- **Dify**: Workflows reference the published version only. Draft changes don't affect running workflows.
- **OpenLegion**: Recommends `schema_version` fields in inter-agent payloads so receiving components can reject incompatible versions. Major interface updates require deploying the receiving agent before the sending agent.
- **Prompt SemVer**: Applying MAJOR.MINOR.PATCH to agent configs — major = breaking output structure changes, minor = new optional capabilities, patch = ambiguity fixes.

#### Recommendation for Octopus

Implement a three-tier resolution strategy:
1. **Pinned** (`agent:123@v2.1.0`): Workflow locks to a specific version. Default for production workflows.
2. **Tag-following** (`agent:123@production`): Workflow follows the production tag. Default for staging/testing.
3. **Latest** (`agent:123@latest`): Workflow always uses newest. Default for development only. Warn users who use this in production.

### 6. Release Management: Lifecycle States

#### Common State Machine

```
  ┌─────────┐    publish    ┌───────────┐    archive    ┌──────────┐
  │  DRAFT  │─────────────▶│ PUBLISHED  │─────────────▶│ ARCHIVED │
  └─────────┘              └───────────┘              └──────────┘
       ▲                         │                          │
       │     restore to draft    │       restore to draft   │
       └─────────────────────────┘◀─────────────────────────┘
```

**Platform implementations:**
- **Dify**: `draft → published → previous_versions`. Restore any previous version to draft. Cannot delete the live release.
- **Coze**: `draft → published → archived`. Preview before publish.
- **LangSmith**: `commit → tagged (staging/production)`. Tags are movable. No explicit "archive" — old commits simply lose their tag.
- **Enterprise custom platforms**: Often add `pending_review` and `approved` states between draft and published, with RBAC controls on who can approve.

#### Approval Workflows

Enterprise platforms add approval gates:
- **Human-in-the-loop**: Agent changes require reviewer approval before publishing (Alignbase pattern).
- **Automated checks**: CI pipeline runs eval suites against the draft. Only passing drafts can be published (Dromeas pattern).
- **RBAC**: Different roles for editor, reviewer, publisher. Publisher cannot be the same person as editor (separation of duties).

#### Recommendation for Octopus

Minimum viable states: `draft → published → archived`. Add an optional `pending_review` state for teams that want approval workflows. The `published` state should be immutable — once published, a version cannot be edited, only superseded by a new version.

### 7. A/B Testing: Running Multiple Versions Simultaneously

#### How Platforms Handle It

**Traffic-split approach** (most common):
- Route a percentage of requests to version A, the rest to version B
- Deterministic hashing on user/session ID ensures consistent routing
- Multi-armed bandit algorithms can dynamically shift traffic toward the winning variant

**Shadow deployment** (lower risk):
- Run the new version in parallel but don't serve its responses to real users
- Compare outputs between versions to validate before cutover
- Used by ShieldBase, AWS SageMaker production variants

**Agent-specific challenges**:
- Agent A/B tests must track 4–5 metrics simultaneously: task success rate, latency, cost, safety, hallucination rate
- External tool calls must remain identical across variants to ensure accurate attribution
- Score distributions matter more than aggregate averages
- Behavioral drift detection: cosine similarity of output embeddings below 0.85 signals "significant behavioral drift"

#### Implementation Patterns

1. **Gateway-level routing** (Maxim AI): The API gateway splits traffic based on configurable percentages. Each variant is a fully independent agent deployment.
2. **Feature flags** (LaunchDarkly-style): Toggle between agent versions per user segment. Good for gradual rollouts.
3. **Contextual bandits** (advanced): Route based on user demographics, preferences, and environmental conditions. Personalizes which version each user sees.

#### Recommendation for Octopus

Start with tag-based routing: workflows can specify `agent:123@canary` alongside `agent:123@production`, with a traffic-split percentage configured at the workflow level. This maps naturally to the tag-based version resolution recommended in section 5. Shadow deployment can be added later as an advanced feature.

### 8. Consolidated Recommendations for Octopus

Based on the research, the following patterns are recommended for Octopus's agent versioning system:

| Area | Recommendation | Rationale |
|------|---------------|-----------|
| **Versioning model** | Snapshot-based (full copy per version) | Industry consensus; trivial rollback; audit-friendly |
| **Version identifier** | Content-addressable hash + human-friendly semver tag | Hash for integrity, semver for communication |
| **Storage** | Separate `agent_versions` table with `snapshot` JSONB column | Standard pattern; clean separation from current state |
| **Lifecycle states** | `draft → published → archived` (minimum); add `pending_review` for approval workflows | Matches Dify/Coze UX; extensible for enterprise |
| **Rollback** | Pointer reassignment (primary) + restore-then-republish (cautious) | Instant rollback for emergencies; reviewed rollback for planned changes |
| **Version resolution** | Three-tier: pinned (production), tag-following (staging), latest (dev only) | LangSmith's proven model |
| **Workflow references** | `agent_id@version_spec` where version_spec is a hash, tag, or `latest` | Flexible; supports all resolution strategies |
| **A/B testing** | Tag-based traffic splitting at the workflow execution layer | Natural extension of the tag-based resolution |
| **Agent manifest** | YAML record capturing full config state, auto-committed on publish | Satisfies EU AI Act audit requirements; enables cross-referencing |
| **Prompt SemVer** | Apply MAJOR.MINOR.PATCH to system prompts and tool configs | Breaking changes = major; new capabilities = minor; fixes = patch |

### Sources

- [LangSmith Prompt & Context Hub](https://docs.langchain.com/langsmith/prompt-context-hub)
- [LangSmith Manage Prompts](https://docs.langchain.com/langsmith/manage-prompts)
- [LangSmith Manage Prompts Programmatically](https://docs.langchain.com/langsmith/manage-prompts-programmatically)
- [LangSmith Prompt Commit / GitHub Sync](https://docs.langchain.com/langsmith/prompt-commit)
- [Dify Version Control Docs](https://docs.dify.ai/en/cloud/use-dify/build/version-control)
- [Dify Enterprise Version Control](https://enterprise-docs.dify.ai/en/3.5.x/use/management/version-control)
- [Dify Roadmap: Version Control v2](https://roadmap.dify.ai/p/version-control-2)
- [Coze App Version Management](https://www.coze.com/open/docs/guides/app_archive_versions)
- [AI Agent Snapshot Strategy (dev.to)](https://dev.to/jackm-singularity/ai-agent-snapshot-strategy-make-risky-changes-reversible-by-default-4gl2)
- [Model Pinning, Prompt SemVer, and Behavior Drift (OpenLegion)](https://www.openlegion.ai/en/learn/ai-agent-versioning)
- [Version-Controlling Your Agents (Towards AI)](https://pub.towardsai.net/version-controlling-your-agents-deployment-rollback-and-safe-promotion-patterns-6b7107dbe82a)
- [A/B Testing Strategies for AI Agents (Maxim AI)](https://www.getmaxim.ai/articles/a-b-testing-strategies-for-ai-agents-how-to-optimize-performance-and-quality/)
- [5 Strategies for A/B Testing AI Agent Deployment (Maxim AI)](https://www.getmaxim.ai/articles/5-strategies-for-a-b-testing-for-ai-agent-deployment/)
- [AI Agent Versioning and Rollback (BuildMVPFast)](https://www.buildmvpfast.com/blog/agent-versioning-rollback-production-ai-update-zero-downtime-2026)
- [Prompt Versioning Tools for Enterprise AI (Lyzr)](https://www.lyzr.ai/blog/prompt-versioning-tools-enterprise-ai)
- [AutoGen → Microsoft Agent Framework Migration](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [AI Agent Approval Workflows (Alignbase)](https://alignbase.ai/blogs/ai-agent-approval-workflows)
- [AI Release Management (Dromeas)](https://dromeas.ai/release-management)
- [A/B Test Agent Deployments (AgentField)](https://agentfield.ai/docs/quick-guides/ab-test-deployments)
- [Shadow Deployment and A/B Testing (ShieldBase)](https://shieldbase.ai/zh/blog/how-ai-is-shadow-deployment-and-a-b-testing-for-enterprise-ai)
- [AI Model Versioning and A/B Testing (Dynatrace)](https://www.dynatrace.com/news/blog/the-rise-of-agentic-ai-part-6-introducing-ai-model-versioning-and-a-b-testing-for-smarter-llm-services/)
