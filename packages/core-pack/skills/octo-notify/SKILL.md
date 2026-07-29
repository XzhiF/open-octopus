---
name: octo-notify
description: Agent notification capability — proactively send status updates to configured channels (Telegram/Discord/Slack/Signal) via hermes
category: devops
tags: [notification, agent, hermes, telegram, alert]
---

# Octo Notify

## Purpose
Enable the agent to proactively send notifications to the user through configured communication channels when important events occur.

## Trigger Conditions
- Long-running task completes (execution > 2 minutes)
- Important milestone reached (e.g., deployment finished, build passed)
- Error or failure detected that needs user attention
- Safe mode activated or deactivated
- Evolution event (skill auto-updated)
- User explicitly requests a notification

## Behavior Instructions

### When to Notify
1. **Task Completion** — Notify when a long-running task (workflow, build, analysis) finishes, especially if the user is likely away
2. **Errors & Failures** — Always notify on critical errors, failed deployments, or workflow execution failures
3. **Milestones** — Notify on significant milestones like "100th session", "first clone merged", etc.
4. **Safe Mode Changes** — Notify when safe mode is auto-activated (14-day inactivity) or manually toggled
5. **Scheduled Task Results** — Summarize scheduled task execution results

### Notification Priority Levels
- **High** (🔴) — Errors, failures, safe mode activation. Send immediately.
- **Normal** (🔵) — Task completions, important events. Send during active hours.
- **Low** (⚪) — Background updates, milestones. Batch and send at next check-in.

### Notification Content Guidelines
- Keep messages concise (under 200 characters when possible)
- Include relevant context: what happened, what action (if any) is needed
- Use emoji sparingly for priority indication
- Include timestamp for async notifications

### Config Reference
The notification channel is configured in `agent config.yaml`:
```yaml
notification:
  platform: telegram  # telegram | discord | slack | signal | none
  target: "telegram:your_chat_id"  # platform-specific target
  timezone: Asia/Shanghai  # IANA timezone for scheduling
```

### How Notifications Work
Notifications are sent via the `hermes` CLI tool:
```
hermes send -t "platform:target" "message"
```

The NotificationService handles:
- Retry logic (3 retries with exponential backoff)
- Failed message queue (up to 100, persisted to disk)
- Platform-specific formatting

## Best Practices
1. **Don't spam** — Batch low-priority notifications; limit to 5 per hour
2. **Respect quiet hours** — Check timezone config; avoid notifications between 22:00-08:00 local time unless high priority
3. **Be actionable** — Every notification should either inform completion or request action
4. **Include context** — Reference the session/task/clone so the user knows what happened without checking the UI
