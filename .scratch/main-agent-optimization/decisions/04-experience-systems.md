# 04 — Experience Systems Unification

Type: grilling | Status: resolved

## Question
DB 经验系统和文件系统经验系统怎么统一？

## Answer
**保持独立，不整合。** DB 系统是 Main Agent 的通用经验库（API 查询、FTS 搜索）。文件系统是 `octo-skill-creator` 的专有技能创建经验。两者各有用途，用户明确不需要整合。DB 保持 DB 为主，文件系统保持独立。
