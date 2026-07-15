# 02 — New agent: product-manager.md

**What to build:** 新建产品经理 agent 定义文件。该 agent 在 expert grill 的 swarm debate 中作为核心专家参与讨论，关注用户价值、MVP 边界、优先级排序。可参考 agency-agents-zh 中已有的产品经理角色适配，或从 product-behavioral-nudge-engine 提取核心能力。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] 创建 `.claude/agents/product-manager.md` agent 文件
- [x] Agent 定义包含: 角色描述、关注维度（用户价值/MVP/优先级）、debate 行为准则
- [x] Agent 能读取项目 CLAUDE.md / CONTEXT.md 了解项目背景
- [x] 验证: agent_file 可被 resolveAgents() 正常解析（格式正确）
