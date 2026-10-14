// packages/shared/src/types/skill-draft.ts
//
// skill 草案（Skill Draft）治理面 — P3 票04（spec §skill 草案管线，故事 15/24）。
//
// 草案 = 「怎么干」资产化的**待授予过程资产**：落知识根 `drafts/skills/{name}/SKILL.md`
// （非 wiki git 仓、非知识页、不进 INDEX）。本文件是草案 front-matter 治理字段的
// 单源契约（server 落盘解析 + 票05 授予链 + web 卡渲染共用）：
//  * status 三值 `draft|granted|revoked`——**没有 pending**（红线3：草案人裁是
//    「授予治理」不是「入库审批」，不建审批队列/待审态）。
//  * origin 三值 = 检测三路（跨 task 序列相似 / 判例蒸馏流程型 / 策展人编译提议）。
//  * source = 来源指针串（`pack:task-{id}` / `task:{id}` / `exec:{id}` / `case:{caseId}`
//    的 `; ` 连接形——草案可溯源，spec 故事 24）。

/** 草案生命周期三态（票面逐字；granted/revoked 的写入者是票05 授予链，本票只产 draft）。 */
export const SKILL_DRAFT_STATUSES = ["draft", "granted", "revoked"] as const
export type SkillDraftStatus = (typeof SKILL_DRAFT_STATUSES)[number]

/** 检测三路来源标记（spec 故事 15 三路逐字）。 */
export const SKILL_DRAFT_ORIGINS = ["sequence-similar", "case-procedural", "curator-proposal"] as const
export type SkillDraftOrigin = (typeof SKILL_DRAFT_ORIGINS)[number]

/**
 * 草案名/目录名钉位（kebab 安全面，同 wiki CASE_ID_RE 制式）：小写字母起头，
 * 仅 [a-z0-9.-]，总长 ≤ 63。无下划线/斜杠/大写 ⇒ 目录穿越与「user_preference」
 * 类人工文件名从字面上不可能撞进 drafts 目录位。
 */
export const SKILL_DRAFT_NAME_RE = /^[a-z][a-z0-9.-]{0,61}[a-z0-9]$|^[a-z]$/
