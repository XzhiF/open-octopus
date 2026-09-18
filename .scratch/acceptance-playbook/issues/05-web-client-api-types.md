# 05 — web: tasks-api 客户端 + 类型镜像

## What to build
`lib/tasks-api.ts`:PlaybookPayload/PlaybookItem/PreviewSummary 等接口镜像 S2/S4;`getPlaybook/startPreview/getPreview/stopPreview`(错误形状同 startVerify);`ClientSpecField` 联合类型 +`"acceptance_preview"`;checks 读写复用 `putHomeFile/getHomeFile`(封装 `saveChecks(taskId,batchDir,round,checks)` 小函数,读失败→{})。

## Blocked by
02, 03

## Status
done

## Acceptance Criteria
- [x] AC1: 409/400/404 → TaskApiError(status 透传),形状与 server payload 一致(手改字段有 tsc 报错保护) — playbook/preview 4 函数统一 `new TaskApiError(body.error ?? HTTP, res.status)`(tasks-api.ts:821-864);live 409/400 经此通道回 toast;web-app tsc/next build 绿

## Verification Method
**type**: unit — 无则 type-level(tsc)+ 下游组件测覆盖(本票不单测)。
