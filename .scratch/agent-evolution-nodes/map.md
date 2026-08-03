# Wayfinder Map: Agent Evolution Nodes

## Destination
Workflow engine gains a `system_agent` node type with `clone@tag` version pinning, full 5-dimension autonomous evolution (persona, skills, prompt, system_prompt, memory) with adversarial review, eval harness, feedback-driven learning, and 5-state version lifecycle (draft → canary → stable → archived / rejected).

## Notes
- Current workflow engine has 10 node types, none connect to the Clone/Main Agent system
- Clone system has 4 built-in clones + 1 new evolution-reviewer
- Main Agent uses 7-segment SystemPromptAssembler (to be externalized)
- Chapter 8: hermes-self-evolution, self-modifying-agent, prompt-auto-optimization, self-evolution-eval, trajectory-verifier, prompt-distillation
- Existing EvolutionService (453 lines) to be extended, not replaced

## Decisions so far

### Phase 1 — Infrastructure
| # | Decision | Gist |
|---|----------|------|
| 01 | Node YAML design | `type: system_agent` + `role: main \| clone` |
| 02 | Evolution scope | 5 dimensions: persona, skills, prompt, system_prompt, memory |
| 03 | Execution runtime | Merge into existing EvolutionService |
| 04 | Review gate | Adversarial review via dedicated evolution-reviewer clone |
| 05 | Triggers | 4 modes: failure threshold, workflow, scheduled, manual |
| 06 | Data storage | DB + file dual layer |
| 07 | Frontend | Complete evolution UI + SSE |
| 08 | Verification | Full layer testing |
| 09 | Test data | Dedicated test clone |
| 10 | Delivery | One-time full delivery |
| 11 | YAML mutation | Overlay mode (DB overrides, no YAML rewrite) |
| 12 | system_prompt target | Externalized config table |
| 13 | engine/server boundary | Context injection |
| 14 | Circuit breaker | 3/h cap + 2 consecutive disable + recursion guard |
| 15 | Failure counting | Sliding window 24h + reset on success |
| 16 | Concurrency | DB lock + optimistic concurrency |
| 17 | Eval sets | Auto + manual population |

### Phase 2 — Intelligence
| # | Decision | Gist |
|---|----------|------|
| 18 | Feedback channel | User 👍/👎 + system auto-score, weighted merge |
| 19 | Eval harness | Sandbox execution + LLM Judge |
| 20 | Longitudinal metrics | All 4: transfer, recovery, negative transfer, cost |
| 21 | Cross-dimension coherence | LLM consistency check |
| 22 | Strategy learning | Pattern extraction + hint |

### Phase 3 — Version Control
| # | Decision | Gist |
|---|----------|------|
| 23 | Version model | 5 states: draft/canary/stable/archived/rejected |
| 24 | Pin syntax | `clone@tag` (@ tag syntax) |
| 25 | Canary promotion | Traffic ratio + min days + auto-promote |

## Not yet specified
- Exact adversarial review prompt template (spec phase)
- LLM Judge evaluation rubric details (spec phase)
- Evolution dashboard layout (spec phase)
- Version cleanup policy details (spec phase)

## Out of scope
- Multi-model evolution
- Cross-clone evolution (one clone learning from another)
- Evolution of workflow YAML structure
- Real-time streaming of evolution progress
- Version branching (parallel evolution branches)
- A/B blind evaluation
