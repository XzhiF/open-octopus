---
name: octo-wiki
description: 编译型知识库（wiki）只读查阅 — 导航协议（INDEX→整读词条→search API 兜底）、引用纪律（wiki_refs / [ref:] / stale 上报）。动手前查 projects/workflows/business/research 四域，卡壳时按症状查 cases。Use before executing tasks and when stuck.
category: knowledge
tags: [wiki, knowledge, navigation, search, citation, cases]
---

# Octo Wiki — 知识查阅（只读）

本 skill 是消费侧查阅协议：wiki 词条由策展人（archive 分身，octo-wiki-curate）编译写入，
执行分身只读。写权单一闸门 = 审核队列 → 策展人编译 → git commit。

## 何时查阅
动手前必查：① 任务涉及某项目 → projects/{name}.md
            ② 执行某工作流角色 → workflows/{name}.md
            ③ 涉及业务口径/术语 → business/  ④ 涉及技术选型 → research/
卡壳时必查：⑤ 报错/异常症状 → search API 打 cases/（symptom+tags 检索先例，
            判例比法条更贴现场；命中案例沿 rule_ref 顺藤读规则）

## 导航协议（编译型 RAG — 按跳计费，禁止全库遍历）
1. Read ~/.octopus/orgs/{org}/knowledge/wiki/INDEX.md   ← 第一跳，~500 token
2. 按 topics/summary 选词条，Read 整篇                     ← 第二跳，整篇消费不碎片
3. 索引未命中 → 检索兜底:
   curl -s "http://localhost:$PORT/api/knowledge/wiki/search?q=超时&org=xzf-dev&topK=5"
   ← FTS5 主检索；BM25/embedding 增强由服务端开关控制

## 引用纪律（效果追踪的数据源）
- 任务产出中声明依据: 关键决策处标注 [ref: oct-007]
- 收尾时 vars_update 写入 —— 单行 JSON，原样照抄结构:
  {"vars_update":{"wiki_refs":["prj-octopus#oct-007", "wf-prd-impl#sop-002"]}}
  ← 引擎只解析 JSON 形态，勿用 YAML 行式（`wiki_refs: [...]` 行式不生效，仅告警不落池）
- 发现词条与实际不符 → 不要沉默: wiki_refs 数组内附 "stale: oct-009 与代码现状矛盾"
  ← 该信号进 effectiveness，触发策展人修订提议（消费侧反哺生产侧）

## 禁止
- 禁止写入 wiki 目录（写权仅策展人）· 禁止把词条全文粘贴进交付物 · 禁止跳过 INDEX 直接 glob
