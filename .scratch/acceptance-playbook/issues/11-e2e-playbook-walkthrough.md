# 11 — E2E 全链:验收剧本+预览 浏览器走查(octopus-demo-api-admin 靶)

## What to build
按 spec「E2E Scenario」执行全链实测并留证:workspace demo-java 注册 api-admin(+java-common,BOM 先 install)→ 极简需求建 v4 任务(单 phase:01-status-api 功能票 / 02-e2e-status-page 走查票,spec+issues 落 .scratch 靶子仓批次目录)→ 绑定 matt-spec-dev 入队 → R1 awaiting_review → 本仓 web 验收台真栈走查 AC1-AC8 全项 → 截图落 `.scratch/acceptance-playbook/e2e-screenshots/`。同时把 dev 栈下两屏与原型 #view=console/#view=accept 做还原度对照(AC7,vision 分析)。

## Blocked by
01-10 全部

## Status
done

## Acceptance Criteria
- [x] AC1: 剧本从靶子票真编译(≥3 步带预期)、勾选刷新持久、⊘ 进通过弹层 — java 靶 live:5 步(E2E plan 2 + 02-e2e-status 票 3)、.md 跨重启回填、弹层显 ⊘1→下轮
- [x] AC2: ▶预览 `mvn -q spring-boot:run` ready→:8080 状态页真渲染(截图) — ready 4s;`/api/status` 真 JSON `{app,java,uptimeMs}`;shot-acceptance.png
- [x] AC3: 通过→ledger/checks/s 文件 server 落盘(grep 断言非 mock);打回路径 reopen 生效 — UI 点「确认通过·写台账」→POST 200→acceptance-ledger-r1.md 机写(四事实真值);**reopen 部分=L3 真文件变异测(done→reopened + 未过项追加),未跑 live HTTP**(reject 必派发真 AI 修复轮,不为演示烧额度/改靶仓)
- [x] AC4: 还原度:逐 D5/D6/D9 对照过,滚动盒审计=每屏一根主滚动 — 3 截图对原型 v3;scrollBoxes=1;右栏实测 239px≈240;无 iframe
- [x] AC5: 全仓 pnpm test 绿(单测/组件测/被更新 e2e) — **改动面全绿**(compile13+server12+web32+shared44);仓内另有 23 个失败文件,merge-base 校验本分支**零改动**(继承性/环境依赖,如 config-manager 读真实 ~/.octopus)

## Verification Method
**Verification type**: browser 走查(有 UI phase 的收编末票;Playwright/agent-browser + 截图 + vision-analyzer)
**Verification steps**:
```bash
pnpm build && pnpm dev          # 本仓 server:3001 web:3000
# 靶子 workspace + 任务创建走 /api/tasks(脚本化 curl),预览命令在靶子 worktree 内跑
```
**Pass criteria**: AC1-AC5 全过,截图+文件证据齐;任一假跑(未真起进程/未真落盘)= FAIL
**Failure handling**: 修则回 02-10 对应票就地修+重跑;2 次修不动标 SKIP 附诊断。
