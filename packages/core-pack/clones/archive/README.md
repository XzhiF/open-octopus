# archive clone assets（fork — 写侧技能的家）

这个目录是 **archive 分身（知识策展人 Curator）的专属资产源**，由 `CloneInitService`
seed 到 `~/.octopus/agent/built-in/archive/`（`persona.md` + `skills/`）。

## 为什么 octo-wiki-curate 必须在分身层，绝不在共享层

ADR-0006 实态（`builtin-clones.ts` getPlugins 注释实证）：**共享技能被所有分身继承**，
`CloneDef.skills` 白名单在运行时并不生效。因此写侧技能一旦放进
`packages/core-pack/skills/`（共享层），等于把 wiki 写权泄漏给全部分身——
spec D4「写入单一闸门（策展人 = archive 分身）」当场失效。

分身层 `~/.octopus/agent/built-in/archive/skills/` 是 ADR-0005 两层模型的分身层，
只有 archive 身份装配时才被发现——这是 curate 技能唯一的合法落位。

| 技能 | 侧 | 层 | 目录 |
|------|----|----|------|
| `octo-wiki` | 读 | 共享层 | `packages/core-pack/skills/octo-wiki/`（票11） |
| `octo-wiki-curate` | 写 | 分身层（仅 archive） | 本目录 `skills/octo-wiki-curate/`（票06） |

红线测试：`wiki-curate-clone-tier.test.ts` + `resource-preflight.test.ts` 双向钉死
（curate 不落共享层、不落其他分身层；octo-wiki 不落任何分身层）。
