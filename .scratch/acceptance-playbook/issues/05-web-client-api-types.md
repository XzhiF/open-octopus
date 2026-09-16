# 05 — web: tasks-api 客户端 + 类型镜像

## What to build
`lib/tasks-api.ts`:PlaybookPayload/PlaybookItem/PreviewSummary 等接口镜像 S2/S4;`getPlaybook/startPreview/getPreview/stopPreview`(错误形状同 startVerify);`ClientSpecField` 联合类型 +`"acceptance_preview"`;checks 读写复用 `putHomeFile/getHomeFile`(封装 `saveChecks(taskId,batchDir,round,checks)` 小函数,读失败→{})。

## Blocked by
02, 03

## Status
pending

## Acceptance Criteria
- [ ] AC1: 409/400/404 → TaskApiError(status 透传),形状与 server payload 一致(手改字段有 tsc 报错保护)

## Verification Method
**type**: unit — 无则 type-level(tsc)+ 下游组件测覆盖(本票不单测)。
