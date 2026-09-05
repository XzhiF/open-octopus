# 02 — Windows 冒号缺陷 + workspace 测试假 USERPROFILE

Status: done

## What
`createFromSpec` 目录名单独 sanitize（`[/\\:*?"<>|]`），`workspaces.name`/config.json 保留 `task:` 展示位；task-ws-name 头注释改口径（展示名≠目录名）。根因二：测试族只假 `HOME`，Windows `os.homedir()` 读 `USERPROFILE` → 直写真实 home（同名撞目录 + 污染）→ 5 个套件补双 env。

## Verification Method
- `npx vitest run tasks-v4-ws-reuse tasks-v4-artifact-loop workspace-service workspace-git task-ws-name` 在 Windows 全绿（此前基线红）
- 真实 `~/.octopus/orgs/e2e-*/` 不再被测试写入（跑后 ls 验证）
