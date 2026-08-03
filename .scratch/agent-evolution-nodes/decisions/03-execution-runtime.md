# 03 — Execution Runtime

Type: grilling
Status: resolved

## Question
How should system_agent nodes execute? Extend CloneRuntime or create new runtime?

## Answer
New `EvolutionRuntime` class, separate from `CloneRuntime`.

- **CloneRuntime**: Handles normal chat execution (persona + memory + skills assembly → provider call)
- **EvolutionRuntime**: Manages the evolution lifecycle (read → diagnose → patch → gate → apply/rollback)

EvolutionRuntime uses CloneRuntime for the actual agent execution within evolution cycles, but adds:
- File I/O for candidate/backup management
- Patch generation and validation
- Review gate orchestration
- Rollback mechanics

**Reason**: Separation of concerns. Evolution is a meta-process that wraps execution, not execution itself.
