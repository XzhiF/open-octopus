# 03 — server: preview 生命周期

## What to build
RoundEvidenceService preview 会话(start/status/stop):闸门与 cwd 逃逸校验同 startVerify(S4);BashExecutor timeout 7200;`readyPattern` 匹配 stdout 或 probe GET url(任意 HTTP 响应)→ ready;exit→exited;`task_preview` SSE(含 external);GET 无会话探一次(800ms)报 external/stopped;routes POST/GET /:id/preview + POST stop。命令含字面 `$vars.`/`${x|` → 400 拒起。

## Blocked by
01

## Status
pending

## Acceptance Criteria
- [ ] AC1: `node -e http server` fixture 起→ready→stop 后端口释放(再 probe 不通)
- [ ] AC2: 进程自发退出 → exited+exit_code;未配置 → 400;无 awaiting/ws 没了 → 409
- [ ] AC3: 外部进程占 url、本服务无会话 → GET {ready,external:true}

## Verification Method
**type**: unit — server 起真子进程(node/python 内联 http),端口用 ephemeral;SSE 断言走 emit spy。
