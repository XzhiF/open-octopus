# 09: workflow-operator 内置分身（第 8 个）

**What to build:** 内置分身注册表新增 workflow-operator（"工作流工程师"）：persona 写死行为准则（动手前查 wiki、引用留痕、安全规则优先、现场代码为准），走 agent_versions 版本发布——工作流 agent 节点的缺省执行身份就位，且可被工作流钉住版本。

**Blocked by:** None (can start immediately)

**Status:** done

**Reference:** spec.md §执行身份（workflow-operator）· prototype.html Tab④（persona/config 骨架，来自原型）· GLOSSARY「内置分身」词条

- [ ] 注册表第 8 个内置分身：英文代号 workflow-operator（符合 /^[a-z0-9-]+$/），显示名"工作流工程师"，不可删除
- [ ] persona 含四条行为准则（原型骨架）：动手前经 octo-wiki 查阅并写 wiki_refs；遵守 cwd 的 CLAUDE.md；安全规则 > 任务书 > 知识参考；知识与现场代码冲突以现场为准并经 wiki_refs 上报 stale
- [ ] config 声明 skills: [octo-wiki]（治理语义 + preflight 依据；运行时按 ADR-0006 继承共享技能，声明不改变发现机制）与版本化标记
- [ ] agent_versions 初始版本发布，IdentityResolver（票 08 产物，若已落）或既有快照解析可解析到它；未落则按既有 octopus_agent 兜底目录机制可解析
- [ ] 内置分身初始化链路（CloneInitService）落 DB 与文件系统双轨，与既有 7 个分身一致；分身列表 API/UI 可见
- [ ] GLOSSARY-MAP「内置分身 (Built-in Clone)」词条更新 7→8
- [ ] 测试：注册表快照测试更新、persona/config 内容断言（expected 取自原型骨架）、初始化幂等
- [ ] 可演示：分身列表出现 workflow-operator，快照解析返回 persona+skills

## Comments
- Merged to integration as ef8188cc (merge of e5ca7d2c, which already contained ticket 08). Build green; targeted 209/209 (registry/init/publish/version-resolver/identity-resolver/engine-init/injection); injection-chain zero diff; 21 pre-existing Windows-env failures unchanged.
- Landed: 8th BUILTIN_CLONES entry (persona verbatim Tab④, skills:['octo-wiki'] governance-only per ADR-0006 comment, config.versioned), agent_versions publish (`publishVersionedBuiltinClones`, INITIAL 1.0.0, idempotent non-fatal startup seed, only operator publishes), shared const `WORKFLOW_OPERATOR_CLONE_NAME`, GLOSSARY 内置分身 7→8.
- For ticket 10: default agent nodes via `WORKFLOW_OPERATOR_CLONE_NAME` from `@octopus/shared` (engine cannot import server BUILTIN_CLONES); built-in detection = server `isBuiltinClone`/`getBuiltinCloneDef`; resolvable through IdentityResolver AND VersionResolver ('latest' + pinned '1.0.0' both proven).
