# 09 — 内置 matt 技能族 seed + Bash 写锁补齐 + context.md 领域指引

## What to build
① matt 技能族（matt-verified-requirement/spec/tickets/domain-modeling/grilling 等）纳入 `~/.octopus/agent/built-in/task-author/skills/` 安装流程（clone-init seed 列表）；② `buildPathGuard` 扩到 Bash：重定向/写命令目标路径检查（白名单=task home 与 /tmp），拦 `>`/`>>`/`tee`/`sed -i` 类外写；③ `context.md` 注入 per-project 绝对路径 + 惯例 probe 指引（CONTEXT-MAP/CONTEXT.md/docs/adr/.scratch/index.md，缺则标注降级）。

## Blocked by
None — can start immediately.

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 新建 coding 任务的 task-author 会话 plugins 含 built-in/task-author/skills（断言加载列表）
- [ ] AC2: `echo x > <home外路径>` 在草稿会话被 hook 拦截，`> /tmp/...` 与 home 内放行（参数化测试 ≥6 例含绕过变体）
- [ ] AC3: context.md 含每个所选 project 的路径行与惯例 probe 结果

## Verification Method
**Verification type**: unit test（guard 参数化）+ integration（seed/context）

**Verification steps**:
1. `packages/server/src/services/agent/__tests__/path-guard.test.ts`（Bash 案例表）
2. clone 会话集成断言 plugins 列表 + context.md 内容（tmp org fixture）
3. `pnpm -F @octopus/server test -- path-guard`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
