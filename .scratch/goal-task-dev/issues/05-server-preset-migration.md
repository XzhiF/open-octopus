# 05 — server:general-dev 换绑 task-dev + 种子版本迁移(存量刷新)

## What to build
看板默认推荐落地:seed 常量换绑 built-in/task-dev + **PRESETS_VERSION 迁移机制**——skip-if-exists 导致存量安装永不刷新(CRITICAL 断点 B),文件内容 ≡ 旧内嵌默认时自动刷新,用户手改则保护;live catalog 同步;task-dev 安装为 built-in 资源。

## Blocked by
04(task-dev.yaml 为引用对象)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: seed general-dev.workflow=built-in/task-dev;新增 PRESETS_VERSION + PREV_DEFAULT_YAML 常量
- [ ] AC2: CloneInitService 迁移:存在且内容哈希≡旧默认 → 刷成新默认(log);用户改过 → 保留 + warn;新建 → 直接写新默认
- [ ] AC3: 单测三用例:旧默认被刷/手改保留+warn/新建直写
- [ ] AC4: 真机 live catalog 刷新验证:重启 server 后 `GET /api/workflow-presets` general-dev=built-in/task-dev;`GET /api/workflows/built-in/task-dev` 200(inputs 三项含 description/default)
- [ ] AC5: PUT task input_values{goal,ac} + confirm → 409 消失 → DB job config.input_values 断言 goal/ac 物化、无 max_turns 键(走 YAML default);`octopus resource install builtin:task-dev` 等效落 registry

## Verification Method
**Verification type**: 单元 + API 集成
**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/services/agent/__tests__/ pnpm build
# dev server :3001 重启后
curl -s localhost:3001/api/workflow-presets | grep -o '"workflow":"built-in/task-dev"'
curl -s localhost:3001/api/workflows/built-in/task-dev | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['parsed']['inputs'])"
```
数据前缀 E2E_TEST_GTD_,cleanup DELETE;断言 DB(matt-sql-executor)。
**Pass criteria**: AC1-AC5 全 PASS,api↔db 交叉(R3)
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
