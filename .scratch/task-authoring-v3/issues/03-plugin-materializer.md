# 03 — PluginMaterializer + getPlugins 任务扩展

## What to build
所选 Skill 组的 skills 从 `~/.octopus/resources/installed/skills/{group}/...` 物化（symlink；Windows junction；失败降级 copy）进 `{home}/skills/{skill-name}/`；「默认通用」组是空标记不物化（D17）。`CloneRuntime.getPlugins(taskHomePath?)` 对 task-author 会话追加第三 plugin 目录；新参数**追加在 chat()/sendWithProvider() 签名尾部**，不重排既有参数（SW-BP15）。

## Blocked by
02 — TaskHomeService（家目录骨架）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `server/src/services/tasks/plugin-materializer.ts`：materializeGroups(home, groups) — 从 registry 解析每组 type=skill 资源的 installPath，逐个 skill 建链接
- [ ] AC2: Windows 优先 junction（无需管理员）；junction 失败→copy 兜底；posix 用 symlink→copy 兜底
- [ ] AC3: group === "default"（内置默认通用）→ 跳过物化，返回空（D17）
- [ ] AC4: 重复物化幂等（已存在同名链接→跳过或替换，不报错）
- [ ] AC5: clone-runtime getPlugins 增可选 taskHomePath；chat()/sendWithProvider() 尾部追加参数；既有调用方（clone/index.ts、main-agent-route、测试）零改动仍通过
- [ ] AC6: task-author send path 在 task 有家目录时传入 taskHomePath

## Verification Method
**Verification type**: unit test + 回归

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/services/tasks/__tests__/plugin-materializer.test.ts
pnpm vitest run src/services/agent/__tests__/clone-runtime.test.ts   # 回归：既有签名兼容
```
temp 目录模拟 registry installPath：物化→readdir 断言链接存在 ∧ SKILL.md 可读穿；default 组→skills/ 为空；既有 clone-runtime 测试全绿（参数顺序未破坏）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
