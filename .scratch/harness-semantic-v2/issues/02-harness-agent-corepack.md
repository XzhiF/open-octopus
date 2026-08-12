# 02 — Harness Agent Core-Pack Definition

## What to build
在 core-pack/agents/ 中注册 harness-agent，使其在分身管理中可见。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [ ] AC1: `packages/core-pack/agents/harness-agent.md` 存在，格式为 .md + YAML frontmatter
- [ ] AC2: Agent 定义包含 name, description, model, tools (bash, read, write, grep, glob)
- [ ] AC3: System prompt 包含 5 种决策类型说明和 JSON 输出格式
- [ ] AC4: 分身管理 API (`/api/clones`) 返回 harness-agent 条目
- [ ] AC5: 分身管理 UI 能看到 Harness Agent 卡片

## Verification Method
**Verification type**: integration test + browser E2E

**Verification steps**:
1. `curl localhost:3001/api/clones | grep harness-agent` — agent 存在于列表
2. 浏览器打开分身管理页面，确认 "Harness Agent" 卡片可见
3. 读取 harness-agent.md 验证 frontmatter 格式符合 core-pack 规范

**Pass criteria**: API 返回 + UI 可见
