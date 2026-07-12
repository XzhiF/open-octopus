---
name: octo-agent-safety
description: Agent safety events and safe mode — intercept dangerous commands, review safety decisions, manage safe mode toggle. Use when auditing agent safety behavior.
category: devops
tags: [agent, safety, safe-mode, dangerous, intercept, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Safety

Monitor and manage agent safety: dangerous command interception, boundary violations, and safe mode control.

## CLI Commands

```bash
# Check safe mode status
octopus agent safe-mode --org <org>

# Enable safe mode
octopus agent safe-mode --org <org> --enable

# Disable safe mode
octopus agent safe-mode --org <org> --disable
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/agent/safety/confirm | Confirm/reject a pending dangerous action |
| GET | /api/agent/safety/events | List safety events (paginated) |
| GET | /api/agent/safe-mode | Get safe mode status |
| POST | /api/agent/safe-mode/enable | Enable safe mode |
| POST | /api/agent/safe-mode/disable | Disable safe mode |

## Safety Event Types

| Type | Description |
|------|-------------|
| `dangerous_command` | Agent attempted a destructive shell command |
| `boundary_violation` | Agent exceeded its permitted scope |
| `safe_mode_toggle` | Safe mode was enabled or disabled |

## Safety Decisions

| Decision | Meaning |
|----------|---------|
| `intercept` | Action blocked automatically |
| `confirm_accept` | User approved the dangerous action |
| `confirm_reject` | User rejected the dangerous action |

## Safe Mode

When enabled, all destructive operations require explicit user confirmation. Auto-enabled after `inactive_days_threshold` days of no activity.
