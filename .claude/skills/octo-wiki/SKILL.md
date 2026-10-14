---
name: octo-wiki
description: 编译型知识库（wiki）只读查阅 — 导航协议（INDEX→整读页→search API 兜底）、引用纪律（wiki_refs / [ref:] / stale 上报）。动手前查五类页：项目/服务/工具→entities · SOP/工作流→topics · 术语/概念→concepts · 溯源→sources；卡壳时按症状查 cases。Use before executing tasks and when stuck.
category: knowledge
tags: [wiki, knowledge, navigation, search, citation, cases]
---

# Octo Wiki — 知识查阅（只读）

本 skill 是消费侧查阅协议：wiki 页由策展人（archive 分身，octo-wiki-curate）编译写入，
执行分身只读。写权单一闸门 = raw 投喂即编译（全局串行队列，唯一写闸收口落盘）→ git commit。

## 何时查阅
动手前必查：① 项目/服务/工具现状 → entities/{name}.md
            ② SOP/工作流硬约束 → topics/  ③ 术语/概念/业务口径 → concepts/
            ④ 溯源某篇源文档 → sources/
卡壳时必查：⑤ 报错/异常症状 → search API 打 cases/（symptom+tags 检索先例，
            判例比法条更贴现场；命中案例沿 rule_ref 顺藤读对应 topics 硬约束锚点）

## 导航协议（编译型 RAG — 按跳计费，禁止全库遍历）
1. Read ~/.octopus/knowledge/wiki/INDEX.md   ← 第一跳，~500 token
   「必读」节所列页先整读（user_preference 全文必读的语义由它承接）。
   注意：必读行写作 `../user_preference.md`——路径相对 INDEX 所在的 wiki 根，
   即 ~/.octopus/knowledge/user_preference.md：owner 偏好住在**知识根**、不在 wiki
   子树（wiki 根下没有这个文件，别按 wiki 根拼路径去读）。
2. 按五类分组选页，Read 整篇                     ← 第二跳，整篇消费不碎片
3. 索引未命中 → 检索兜底:
   curl -s "http://localhost:$PORT/api/knowledge/wiki/search?q=超时&org=global&topK=5"
   ← FTS5 主检索 + LIKE 降级；wiki 全局唯一（D6①），org 钉 'global'（可省略）

## 引用纪律（效果追踪的数据源）
- 任务产出中声明依据: 关键决策处标注 [ref: oct-007]
- 收尾时 vars_update 写入 —— 单行 JSON，原样照抄结构:
  {"vars_update":{"wiki_refs":["prj-octopus#oct-007", "wf-prd-impl#sop-002"]}}
  ← 引擎只解析 JSON 形态，勿用 YAML 行式（`wiki_refs: [...]` 行式不生效，仅告警不落池）
- 发现词条与实际不符 → 不要沉默: wiki_refs 数组内附 "stale: oct-009 与代码现状矛盾"
  ← 该信号随执行落 JSONL/DB，经巡检/策展人消费成为知识中心对话里的 finding（消费侧反哺生产侧）

## 禁止
- 禁止写入 wiki 目录（写权仅策展人）· 禁止把词条全文粘贴进交付物 · 禁止跳过 INDEX 直接 glob
