# ArchiveMode: caller-declared, not auto-detected

Workspace archival supports two modes: `full` (copy state/logs/docs to archive directory) and `cleanup` (DB records only, delete files immediately). The mode is explicitly declared by the caller (CLI, UI, scheduler) — never auto-detected from workspace properties.

Auto-detection was considered (e.g., `execution_count == 0` or `lifespan < 1 day` implies test workspace) but rejected: short-lived workspaces can contain critical failure data, and heuristic misclassification silently destroys analysis-worthy files. Explicit declaration costs one parameter at the call site; mis-auto-detection costs irrecoverable data.
