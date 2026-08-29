# 09 — workflow-schema.json 路线:恢复源文件 vs 废弃

Type: grilling
Status: resolved
Blocked by: 01

## Question

(research 08 发现 schema 管线断链:2bc5951d 批量清理连坐删除源文件,sync existsSync 静默跳过,~/.octopus 孤儿 + 多处悬空引用。恢复 vs 废弃 vs 不管。)

## Answer

**B — 废弃 JSON schema 路线**(用户拍板:"不要JSON schema,要来没用")。
- 删除 3 个 workflow YAML 的 `# yaml-language-server: $schema=…` 头注释
- octo-workflow-dev SKILL/references 改指真权威:shared Zod parser(`packages/shared/src/yaml/parser.ts`)+ references 文档;顺带补 goal 模式新语义(goal=/goal condition、节点级 max_turns/max_budget_usd/disallowed_tools、tools 接线、planning 废弃)
- 删除 `~/.octopus/workflow-schema.json` 孤儿;sync-builtin.mjs/setup-runner 的 schema 同步逻辑移除
- 双源维护问题终结,goal 语义只写在 Zod + skill references 两处
