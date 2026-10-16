# 01: Ops 前置 — D2 复验 + P0/P1 合入 main

**What to build:** P0/P1 集成作为干净基线进入 main：合入前对 D2 修复（缺省身份节点的技能物化）做运行时复验（E2E 报告曾判 FAIL、修复 commit 在其后落地但未复验），复验通过后走 PR 合入，本 phase 从 main 开新分支。

**Blocked by:** None (can start immediately)

**Reference:** `.scratch/knowledge-center/spec.md` §Further Notes「前置 ops」· `.scratch/llm-wiki-loop/e2e-report.md`（复现步骤 + D2 根因节）· p2-gate-pass.md §5 缓解条件④

**Status:** done

- [x] integration 分支起 dev 实例（隔离端口/DB 快照，保护端口 3000/3001/3098/3099 不碰），跑既有 E2E 复跑脚本 → 9/9 全绿
- [x] 补 D2 运行时断言：一条**无 skills 声明且无 as:** 的 agent 节点执行后，workspace `.claude/skills` 含 octo-wiki（证明修复在运行时生效，非仅单测绿）
- [x] PR 建立并合入 main（PR 描述挂审计链：spec + 13 票 + e2e-report + p2-gate-pass）
- [x] 本 phase 工作分支从合入后的 main 开出
- [x] 拆机三段式收尾（pnpm port → kill:port → netstat 复核）；复验证据（JSONL 行/目录清单）附进票 Comments

## Comments

**2026-10-13 复验与合入（executor: Claude Code, session KC）**

- Host：`.worktrees/integration` @ `faa9c5a6`，`pnpm build` 全绿后 `pnpm dev --port 3410,3411 --skip-build`；分支库 `octopus-feat-llm-wiki-loop-20261012.db`（默认库只读）；真 provider 闸 `models/test sonnet → success`（非 mock）
- **e2e13-rerun.mjs → 9/9 ALL PASS**：exec `4caf6c99-7ab2-464b-a1b4-3ece45aed5ab`，ws `E2E13_RERUN_1791872909272`（evidence1 JSONL INDEX→词条序列 / evidence2 wiki_refs+真锚点 / evidence3 article sources+gitHistory / evidence4 shadow querySide 全绿）
- **D2 运行时断言（新脚本 `C:/tmp/llm-wiki-notes/e2e13/d2-rerun.mjs`）→ 8/8 PASS**：exec `249af7e8-b744-491a-b0eb-7260875ff4e3`，ws `d2_rerun_1791872975914`（`C:/Users/EDY/.octopus/orgs/xzf-dev/workspaces/d2_rerun_1791872975914`）——无 `as:` 无 `skills:` 缺省节点执行后 `.claude/skills/octo-wiki/SKILL.md` 物化在场；engine_init JSONL 含 provisioning 证据行（`{"timestamp":"2026-10-13T06:29:41.025Z","nodeId":"__engine_i…`）；物化字节 == 运行时预置源 `~/.octopus/resources/installed/skills/built-in/octo-wiki/SKILL.md`
- 目录清单（D2 workspace）：`.claude/skills` = [octo-wiki, …其余通道技能]；octo-wiki 经 identity config.skills 双源合并（770d9fa6）物化
- 合入：**PR #74 已 MERGED**（merge commit `45e4b87ae628b8e742dd52e6601929e1cb8ff1b4`，CI build-lint SUCCESS；证据评论 `pull/74#issuecomment-6139739345`）——注意 origin 实为 `XzhiF/open-octopus`
- 拆机：kill:port 3411/3410 → netstat 复核 34xx 全清；清障一次上会话 next dev 僵尸（PID 16504 @3210，同目录锁曾致 web exit 1、连带 dev.mjs 拉闸 server）
- 本 phase 工作分支：`feat-knowledge-center-20261013` @ `45e4b87a`，worktree `.worktrees/kc-int`

**决策（2026-10-13，KC 主会话）：** 本票按票面字面验收——既有 e2e13-rerun 9/9（脚本自带 provider ping + completed exec 真跑）+ 缺省节点 D2 物化 8/8。fixture 形态为 `type: agent` 无 `as:` 无 `skills:` 直跑；**未**额外跑 task-board v4 全链（该链属票 15 链③/④覆盖面）。如后续 E2E 在 task-board 通道复现缺省节点技能缺席，按回归缺陷走票 15 补救轮，不回头翻本票。
