# task-author clone assets（fork — 故意不同步上游）

这个目录是 **task-author 分身的专属资产源**，由 `CloneInitService` seed 到
`~/.octopus/agent/built-in/task-author/`（`persona.md` + `skills/`）。

## 为什么是 fork 而不是引用共用源

这些技能原本从仓库 `.claude/skills/` 拷贝——那是**开发会话**的技能树，面向的是
「澄清需求 → 直接开发 → 交付」的一条龙流程。task-author 只做前半段：**产规格、
不执行**。两者需要的技能是有实质差异的，共享一份就会让 task-author 会话加载到
「Next Steps: 跑 matt-dev-pipeline / matt-pipeline-loop」这类执行侧出口。

本目录的 6 个技能相对 `.claude/skills/` 同名技能**有意分叉**，主要差异：

| 技能 | 改动 |
|------|------|
| `matt-verified-requirement` | 删 `Execution Decisions Gate` 三问（只保留 Story Walk-Through 一问）；删下游产物表；`Next Steps` 改为「交还用户等 [入队]」并**明文禁止**提议执行流水线；frontmatter description 去掉 execution-options 措辞 |
| `matt-verified-tickets` | 删对 `matt-dev-pipeline` Phase 1 / `matt-dev-runner` 的引用；Rule 5 验证类型阶梯原样保留 |
| `matt-verified-spec` | 删 `matt-sql-executor` 技能名引用 |
| `domain-modeling` / `grilling` / `wayfinder` | **无改动**（本就零执行耦合，原样拷贝） |

## ⚠️ 上游更新不会自动流入

这是**刻意的**——不要把本目录改回软链或同步。`.claude/skills/` 里同名技能的更新
**不会**传播到这里；反过来这里也不会影响 `.claude/skills/`。

判断某处改动该落哪边：

- 是**作者视角**的纪律（怎么写 spec/票、怎么拆 phase、出口是什么）→ 改**这里**
- 是**执行视角**的纪律（怎么实现、怎么跑测试、怎么交付）→ 改 `.claude/skills/`

两边都需要的（如「末张验收票」契约）→ 两边都改，并在 commit message 里点明。

## seed 与刷新

`CloneInitService.seedTaskAuthorAssets()` 按 `.seed-manifest.json` 逐文件 sha256
比对：与 manifest 记录一致的 → 用本目录覆盖（升级生效）；被用户手改过的 → 保留并
warn；manifest 缺失（老安装首次迁移）→ 备份现有 `skills/` 到 `skills.bak-<ts>/` 后
全量覆盖。详见 `packages/server/src/services/agent/clone-init-service.ts`。

**手改 clone 里的技能前请注意**：改了就会被记为用户修改，此后上游更新不再覆盖它
（这是保护，不是 bug）。想重新接收更新，删掉该文件让 seed 重新写入。

## persona.md 与 builtin-clones.ts 的一致性

`persona.md` 必须与 `packages/server/src/services/agent/builtin-clones.ts` 的
`TASK_AUTHOR_PERSONA` **逐字一致**——前者是权威（`loadPersona()` 优先读文件），
后者是文件缺失时的 fallback。有测试钉死这条；改动其一必须同步另一个。