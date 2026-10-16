# 10: `as:` 字段 + agent 节点身份装配

**What to build:** 工作流作者在 agent 节点写 `as: <分身代号>` 即获得该分身的 persona+skills 装配（cwd 不变）；不写则缺省装配 workflow-operator——存量工作流零改动获得执行身份，引擎自身仍无人格。`as:` 目标不可解析时引擎初始化即硬闸拒绝，不带病执行。

**Blocked by:** 08（IdentityResolver prefactor）, 09（workflow-operator 分身）

**Status:** done

**Reference:** spec.md §执行身份（P1）· prototype.html Tab②D1（三分离决策）/Tab④（YAML 形态，来自原型）· ADR-0005/0006

- [ ] shared 工作流 schema：NodeDef 增可选 `as` 字段（分身英文代号）；三层验证体系 L3 语义层加"as: 目标可解析"存在性检查（requires.clones 硬闸先例），engine-init 阶段拒绝不可解析目标
- [ ] agent 节点执行时经 IdentityResolver 装配：snapshot.persona → systemPrompt、snapshot.skills → Skill Filter 白名单；**cwd/workspace 隔离语义零变化**（mock provider 捕获断言）
- [ ] 缺省行为：未写 `as:` 的 agent 节点装配 workflow-operator；octopus_agent 节点语义不变（重量级委托回归绿）
- [ ] CLI 与 Server 双入口行为一致（CLI 路径同样走 IdentityResolver 装配）
- [ ] loop/swarm/sub_workflow 子引擎内 agent 节点继承同一装配语义
- [ ] 注入链零改动硬约束：PromptInjector/KnowledgeInjector/precompute 行为不受本票影响（既有注入相关测试原样绿）
- [ ] 新 ADR「纯引擎 + 执行身份」落 docs/adr/ 顺延编号（难逆转决策：引擎无人格、身份是节点数据、三分离）
- [ ] GLOSSARY-MAP 入册「执行身份 (Execution Identity)」；engine 包 GLOSSARY 同步
- [ ] S2 缝测试：显式 as: 装配断言（systemPrompt/skills/cwd 三件套）、缺省 operator 断言、硬闸报错断言、schema 校验（config-validation.test 先例）
- [ ] 可演示：.test.yaml 模拟器 + mock provider 跑通显式与缺省两种装配

## Comments
- Merged to integration as 291c86a9 (merge of 4b84017d/9935c281). Build+sync green; engine 883/8 (=855+28 new, 8 pre-existing machine-bound unchanged), shared 912/1 (only pre-existing model-alias), injection 19/19+134/134 green; injection-chain diff EMPTY (engine.ts +24 lines = identity-seam only).
- NodeDef `as?` (`shared/types/workflow.ts:223`, zod /^[a-z0-9-]+$/ :358); L3 gate `engine-init.ts:304–320` via new `identity-gate.ts` (collectAsRefs/checkAsRefs), CLI parity in cli workflow.ts (exit 1). Assembly `identity-assembly.ts`: persona→preset append (host-safety preserved), skills→SDK whitelist union, cwd untouched, default WORKFLOW_OPERATOR_CLONE_NAME. `versionResolver?` optional → CLI fs-only (08 gap closed). loop/sub_workflow/dynamic child engines thread same resolver.
- ADR-0029 + GLOSSARY 执行身份 landed. Handoff for 12/13: `C:\tmp\llm-wiki-notes\handoff-10.md` — wiki_refs ride vars_update→VarPool at `agent.ts:152`.
