---
name: octo-agent-config
description: Agent runtime configuration — view and update model, timeout, clone limits, notification, memory retention, and safe mode settings. Use when tuning agent behavior.
category: devops
tags: [agent, config, settings, model, timeout, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Config

View and update agent runtime configuration stored in `~/.octopus/{org}/agent/config.yaml`.

## CLI Commands

```bash
# View current config
octopus agent config --org <org>

# Update a config field
octopus agent config --org <org> --set model=pro
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agent/config | Get full runtime config |
| PUT | /api/agent/config | Update config fields (partial) |

## Config Schema

```yaml
model: pro
timeout: 300
max_clones: 5
notification:
  provider: slack
  target: "#agent-alerts"
  timezone: Asia/Shanghai
memory:
  session_retention_days: 30
  archive_cron_hour: 3
  long_term_refine_trigger_days: 7
  session_compress_threshold_messages: 50
safe_mode:
  enabled: false
  inactive_days_threshold: 30
debug:
  enabled: false
onboarding_completed: true
default_org: xzf
```

## Degraded Mode

If `config.yaml` is missing or corrupt, the agent falls back to defaults with `degraded=true`. Individual invalid fields degrade independently.
