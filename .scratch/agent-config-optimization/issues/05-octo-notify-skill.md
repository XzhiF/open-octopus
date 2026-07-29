# Ticket 05 — octo-notify Skill

Status: done (commit 882bd1b)
Priority: P2
Packages: core-pack

## Scope

Create `octo-notify` skill so the Agent is aware of its notification capabilities and can proactively notify users.

## Changes

### Create Skill File
**File: `packages/core-pack/skills/octo-notify/SKILL.md`**

YAML frontmatter:
```yaml
---
name: octo-notify
description: "Agent notification capability — proactively send status updates to configured channels (Telegram/Discord/Slack/Signal) via hermes"
category: devops
tags: [notification, agent, hermes, telegram]
version: 1.0.0
priority: medium
---
```

Content sections:
1. **Overview** — Agent has a configured notification channel for proactive updates
2. **When to Notify** — Long-running tasks completing, important events, errors, milestones
3. **Notification Priority** — high (🔴 urgent), normal (🔵 informational), low (⚪ background)
4. **Config Reference** — `notification.platform`, `notification.target`, `notification.timezone` from agent config
5. **How to Notify** — Reference the existing NotificationService (uses `hermes send` CLI)
6. **Best Practices** — Don't spam, batch low-priority updates, respect quiet hours

## Verification
- `pnpm build` passes
- Skill file exists at correct path with valid YAML frontmatter
- `pnpm test` passes
