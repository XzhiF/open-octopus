# 11 — E2E 全链:验收剧本+预览 浏览器走查(octopus-demo-api-admin 靶)

## What to build
按 spec「E2E Scenario」执行全链实测并留证:workspace demo-java 注册 api-admin(+java-common,BOM 先 install)→ 极简需求建 v4 任务(单 phase:01-status-api 功能票 / 02-e2e-status-page 走查票,spec+issues 落 .scratch 靶子仓批次目录)→ 绑定 matt-spec-dev 入队 → R1 awaiting_review → 本仓 web 验收台真栈走查 AC1-AC8 全项 → 截图落 `.scratch/acceptance-playbook/e2e-screenshots/`。同时把 dev 栈下两屏与原型 #view=console/#view=accept 做还原度对照(AC7,vision 分析)。

## Blocked by
01-10 全部

## Status
pending

## Acceptance Criteria
- [ ] AC1: 剧本从靶子票真编译(≥3 步带预期)、勾选刷新持久、⊘ 进通过弹层
- [ ] AC2: ▶预览 `mvn -q spring-boot:run` ready→:8080 状态页真渲染(截图)
- [ ] AC3: 通过→ledger/checks/s 文件 server 落盘(grep 断言非 mock);打回路径 reopen 生效
- [ ] AC4: 还原度:逐 D5/D6/D9 对照过,滚动盒审计=每屏一根主滚动
- [ ] AC5: 全仓 pnpm test 绿(单测/组件测/被更新 e2e)

## Verification Method
**Verification type**: browser 走查(有 UI phase 的收编末票;Playwright/agent-browser + 截图 + vision-analyzer)
**Verification steps**:
```bash
pnpm build && pnpm dev          # 本仓 server:3001 web:3000
# 靶子 workspace + 任务创建走 /api/tasks(脚本化 curl),预览命令在靶子 worktree 内跑
```
**Pass criteria**: AC1-AC5 全过,截图+文件证据齐;任一假跑(未真起进程/未真落盘)= FAIL
**Failure handling**: 修则回 02-10 对应票就地修+重跑;2 次修不动标 SKIP 附诊断。
