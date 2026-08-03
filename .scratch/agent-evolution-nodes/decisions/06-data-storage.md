# 06 — Data Storage

Type: grilling
Status: resolved

## Question
How should evolution data (patches, logs, candidates) be stored?

## Answer
DB + file dual layer:

### DB Tables
- `evolution_patches` — id, clone_name, dimension, diff, status (candidate/applied/rejected/rolled_back), review_result, created_at
- `evolution_logs` — id, clone_name, trigger_type, dimensions, outcome, duration_ms, created_at

### File System
```
~/.octopus/{org}/agent/evolution/{clone-name}/
├── patches/          # Individual diff files
├── candidates/       # Pending candidate files
├── backups/          # Previous versions for rollback
└── eval-results/     # Verification results
```

**Reason**: DB enables querying history and metrics; files provide the actual content and backup for rollback.
