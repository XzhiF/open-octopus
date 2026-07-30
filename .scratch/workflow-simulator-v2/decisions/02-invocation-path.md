# 02 — 调用路径: 开发者怎么触发完整测试闭环?

Type: grilling
Status: resolved
Blocked by: 01

## Answer

**Workspace clone + skill**

开发者两条路径都可触发:
1. **Claude Code 直接**: `@@workspace 帮我测试 workflows/my-flow.yaml` → workspace clone 加载 octo-workflow-test skill
2. **CLI 间接** (Phase 2): `octopus workflow test my-flow.yaml` → CLI `POST /api/agent/chat { delegate_to: "workspace" }` → 同上

Workspace clone 同时拥有 octo-workflow-dev (创建) + octo-workflow-test (测试)，完整覆盖工作流生命周期。
