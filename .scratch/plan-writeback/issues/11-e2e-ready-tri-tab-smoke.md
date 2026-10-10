# 11: E2E 流⑦ — 待执行三签态 UI-only 烟测

> Spec: 同 07 追加裁决轮；harness：taskboard e2e 六流（workers=1）

**What to build:** 一条**不经 LLM** 的快流（秒级）：seed 一个 ready 任务（建任务→入队，不 trigger）→ 开控制台 → 断言三页签齐、默认落节点且节点行=绑定流 YAML 序列全 ○ → 对话签出草稿回放（seed 时写两条会话消息或断言空态文案）→ 规格签清单全 ✓ 无写控件 → 右栏角标点开浮层含命中率与「完整台账」、点外收回。既有六流回归合跑不翻红。

**Blocked by:** 07, 08, 09, 10。

**Status:** done

- [x] 流⑦入 taskboard-v2 套件，workers=1 全量七流串跑绿
- [x] 全程零真 provider 调用（不调 trigger，纯 UI+REST seed），单跑目标 <60s
- [x] 隔离口径沿用 tbv2Env（专属库硬拒真库）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-11@5a13347c；单跑 5.1s/串跑 7 passed 7.9m；三偏离入档：helpers dbOpen 写侧 {} 修、绑定流取 built-in/budget-test（home-file 白名单边界）、seed 机件纯增量 tbv2SeedReadyTask）。2026-10-10。
