# 02 — server: playbook 编译器

## What to build
`round-evidence-service.ts` + `getPlaybook(taskId)`:按 spec S2 解析批次目录五类输入 → `PlaybookPayload`;解析原语复用/仿 `lib/acceptance-matrix.ts` 的 parsePipeTableAfter 思路(server 侧本地小函数即可,markdown 约定=票 Status/Verification Method 节、e2e-test-plan Step 块);按票归并 ≤4 条、全剧 ≤8 步、爆表降档 degraded;`routes/tasks.ts` GET /:id/playbook(409/404 classifyError 同 verify)。缺料→available:false+coverage.missing,HTTP 200。

## Blocked by
无

## Status
pending

## Acceptance Criteria
- [ ] AC1: fixture 全料 → 票级步(每 item op/expect/evidence 非空)、finePrint 收录票内全部 AC、id 稳定(两次调用相同)
- [ ] AC2: 缺全部文件 → available:false 不崩;部分缺 → coverage 如实
- [ ] AC3: 9+ 票步 → degraded 故事级(每票 1 条)
- [ ] AC4: 上轮 checks-r{N-1}.json skip/fail → carryover 段(带 fromRound/decision/note)

## Verification Method
**type**: unit(vitest)— 临时目录 fixture 写 markdown,直接 service 级测(仿 tasks-verify.test.ts 装配)。
