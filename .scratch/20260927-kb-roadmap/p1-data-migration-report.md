# P1-B1 · 74MB 数据搬迁对账报告（SQLite → PG COPY）

- 时间: 2026-09-27T19:31:56.512Z → 2026-09-27T19:31:59.304Z
- 源: `/Users/xzf/.octopus/db/octopus.db` · SQLite user_version = 49 · readonly
- 目标: `postgres://***@127.0.0.1:5432/octopus`
- 模式: 实灌 + `--quarantine`（脏行放行隔离）
- 结论: **带隔离完成（隔离 293 行）** · exit 2

搬迁 42 表；装载序 = PG 实际 FK 边（pg_constraint）Kahn 拓扑（父先于子，并列字典序；依据：FK 边两侧一致性由 B0 schema-parity 测试证明）：

```
agent_events → agent_versions → archive_drafts → billing_price_config → billing_setting → chat_messages → chat_sessions → clones → evolution_log → execution_archive → experiences → harness_config → harness_events → insight_marks → knowledge_effectiveness → orgs → pending_review → reports → safety_events → schedule_audit_logs → scheduled_job_executions → scheduler_audit_logs → scheduler_state → sessions → messages → task_phase_acceptances → tasks → workspace_archive → workspaces → executions → execution_summaries → interaction_messages → node_edges → node_executions → branch_executions → llm_calls → node_token_usages → optimization_suggestions → pipeline_state → schedules → schedule_executions → schedule_workspaces
```

同步清空的 FTS 占位表（不搬迁）: `session_memory_fts` · `experiences_fts` · `reports_fts`

## §1 逐表行数（sqlite vs pg）

| 表 | sqlite 总 | 隔离 | 应落库 | pg 实测 | 一致 |
|---|---:|---:|---:|---:|:---:|
| agent_events | 109088 | 123 | 108965 | 108965 | ✓ |
| agent_versions | 0 | 0 | 0 | 0 | ✓ |
| archive_drafts | 0 | 0 | 0 | 0 | ✓ |
| billing_price_config | 1 | 0 | 1 | 1 | ✓ |
| billing_setting | 0 | 0 | 0 | 0 | ✓ |
| chat_messages | 31 | 0 | 31 | 31 | ✓ |
| chat_sessions | 2 | 0 | 2 | 2 | ✓ |
| clones | 6 | 0 | 6 | 6 | ✓ |
| evolution_log | 0 | 0 | 0 | 0 | ✓ |
| execution_archive | 27 | 0 | 27 | 27 | ✓ |
| experiences | 0 | 0 | 0 | 0 | ✓ |
| harness_config | 0 | 0 | 0 | 0 | ✓ |
| harness_events | 68 | 0 | 68 | 68 | ✓ |
| insight_marks | 0 | 0 | 0 | 0 | ✓ |
| knowledge_effectiveness | 0 | 0 | 0 | 0 | ✓ |
| orgs | 1 | 0 | 1 | 1 | ✓ |
| pending_review | 0 | 0 | 0 | 0 | ✓ |
| reports | 0 | 0 | 0 | 0 | ✓ |
| safety_events | 0 | 0 | 0 | 0 | ✓ |
| schedule_audit_logs | 0 | 0 | 0 | 0 | ✓ |
| scheduled_job_executions | 0 | 0 | 0 | 0 | ✓ |
| scheduler_audit_logs | 162 | 0 | 162 | 162 | ✓ |
| scheduler_state | 1 | 0 | 1 | 1 | ✓ |
| sessions | 110 | 0 | 110 | 110 | ✓ |
| messages | 138 | 0 | 138 | 138 | ✓ |
| task_phase_acceptances | 93 | 0 | 93 | 93 | ✓ |
| tasks | 68 | 0 | 68 | 68 | ✓ |
| workspace_archive | 0 | 0 | 0 | 0 | ✓ |
| workspaces | 19 | 0 | 19 | 19 | ✓ |
| executions | 47 | 15 | 32 | 32 | ✓ |
| execution_summaries | 37 | 10 | 27 | 27 | ✓ |
| interaction_messages | 67 | 0 | 67 | 67 | ✓ |
| node_edges | 98 | 15 | 83 | 83 | ✓ |
| node_executions | 238 | 39 | 199 | 199 | ✓ |
| branch_executions | 0 | 0 | 0 | 0 | ✓ |
| llm_calls | 2801 | 76 | 2725 | 2725 | ✓ |
| node_token_usages | 151 | 13 | 138 | 138 | ✓ |
| optimization_suggestions | 0 | 0 | 0 | 0 | ✓ |
| pipeline_state | 0 | 0 | 0 | 0 | ✓ |
| schedules | 2 | 0 | 2 | 2 | ✓ |
| schedule_executions | 115 | 2 | 113 | 113 | ✓ |
| schedule_workspaces | 0 | 0 | 0 | 0 | ✓ |

## §2 抽样列值比对

全等 —— 每表 sha256 稳定排序抽 5 行（不足取全表）× 全部映射列：时间戳两侧 epoch-ms、JSON 稳定序列化（键排序）、布尔 0/1↔bool、整数/浮点按类型、文本逐字，逐一相等。

## §3 脏数据清单（293 条）—— 喂 P3 quarantine 设计

- **agent_events · event_order · int-col-out-of-range** × 123（已隔离，不入库）
    - `121376d6-b1b5-4423-8fb1-b4915611fb43-__engine_init__1786128117918` = 1786128117918
    - `6c56050c-d366-4324-99f3-31e1a372f06c-__engine_init__1786128427965` = 1786128427965
    - `6c56050c-d366-4324-99f3-31e1a372f06c-__engine_init__1786128427966` = 1786128427966
    - `8a0edc39-e4fe-469d-84cb-dcb02e6b00fa-__engine_init__1786128668541` = 1786128668541
    - `8a0edc39-e4fe-469d-84cb-dcb02e6b00fa-__engine_init__1786128668542` = 1786128668542
    - `8a0edc39-e4fe-469d-84cb-dcb02e6b00fa-__engine_init__1786128668543` = 1786128668543
    - `d278d8e9-a47c-48bd-9dd6-64263b975b29-__engine_init__1786128861361` = 1786128861361
    - `41ccf52a-8e7c-4ade-bfa3-31e0d03b6d33-__engine_init__1786129225357` = 1786129225357
    - `6a245a08-bc07-4803-8528-d50609bfa26e-__engine_init__1786148801360` = 1786148801360
    - `c6c04a8b-e1d3-446b-850f-915d5674eb6a-__engine_init__1786151548998` = 1786151548998
    - …其余 113 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **execution_summaries · execution_id · fk-orphan** × 10（已隔离，不入库）
    - `2ee78c89-b8cf-46ac-8c48-d368588ac8c0` = -> executions.id = db24c6b2-8f8f-42aa-a2cd-ab8e94410923
    - `7a7e568d-8a38-4bcf-8f8f-84ad6af99656` = -> executions.id = f25fba87-beed-44f1-a1c8-1b1d73846ccd
    - `4bbf960f-9c04-45fb-bd69-86a501322d1d` = -> executions.id = feec748f-34f0-4ffc-b36e-7608412c048f
    - `3dc4792f-f187-4a6a-873e-dc9f05c1f429` = -> executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263
    - `80e370f5-52f1-4bf5-9185-295af64d198d` = -> executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6
    - `1db0b02c-98bd-48eb-9d3a-daa41e612763` = -> executions.id = ab67da28-d1b0-4099-98a9-075f88793bb3
    - `6ccbc1d7-7976-41c4-bab1-5cd512be2d74` = -> executions.id = fc95a0be-7610-4197-865f-779b08ff70ee
    - `d5404e69-9abd-4b73-b16a-a5db9d69d81d` = -> executions.id = 0f4bd923-63e5-4562-b563-b23b9fd07669
    - `980feaef-642a-4f41-a15e-b977c3adb046` = -> executions.id = 95e80508-eba8-433c-97f4-5e553fe95d72
    - `3e511f2f-3ab2-4479-9d33-7d94cd2ae4bd` = -> executions.id = 572961f4-8eea-4eac-b5d6-f543b418fb26
- **executions · workspace_id · fk-orphan** × 15（已隔离，不入库）
    - `b5065355-bc12-4cb4-8e2b-b9a093a14cb4` = -> workspaces.id = d16651da-d264-4a73-bc5d-6eea3d2af2bf
    - `c257b085-e147-42b6-9269-8d3910bff262` = -> workspaces.id = e4e68339-da23-4a25-80b4-0139a471df2f
    - `f25fba87-beed-44f1-a1c8-1b1d73846ccd` = -> workspaces.id = a5774d75-2f79-4f8c-999c-40da8fb7cbbe
    - `feec748f-34f0-4ffc-b36e-7608412c048f` = -> workspaces.id = f1f6f9a6-3537-44bf-8161-2b243432302e
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6` = -> workspaces.id = 49561467-a88e-4f7b-8c2d-c3bbac7662e2
    - `b5593c0e-3830-49c4-91aa-1241dccce460` = -> workspaces.id = 2a83b74c-b2f4-435d-9fb1-e4b2b3039c82
    - `ab67da28-d1b0-4099-98a9-075f88793bb3` = -> workspaces.id = 2a83b74c-b2f4-435d-9fb1-e4b2b3039c82
    - `345620f4-9ae1-404e-8bb0-7b14278bd657` = -> workspaces.id = 83a55ce9-fd5f-4b65-bff1-773d17ff3663
    - `1b783aa2-4af1-472d-875a-fa4d0b9adbb2` = -> workspaces.id = 8b022fdc-6805-4835-87f7-1942263d0067
    - `a06a3521-e8fe-48f1-91cc-a2394d03b2b4` = -> workspaces.id = 7e2f3d3b-9c5c-4da0-9266-a632e9c9f493
    - …其余 5 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **llm_calls · node_execution_id · fk-orphan** × 76（已隔离，不入库）
    - `5a618f81-3b3c-4e52-bcc4-e0cc0a74d5d3` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-selector
    - `f29ec430-24ca-4923-b84f-d18cfcce0038` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-selector
    - `8b69cced-2395-44ec-bdd5-4cc3eba263f0` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-selector
    - `e0a97f8f-08ee-4fb8-b6a2-7f66ed6ac566` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-selector
    - `47e6312b-45ec-4e12-8a30-82c5f30f920d` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-1
    - `fdeb74fb-91f8-48a4-b7db-848a9ebc38a8` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-2
    - `68679539-8e90-4fdc-9187-cf21942c02a7` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-2
    - `a41f8f4c-36eb-4f88-a8b6-61655347d33a` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-3
    - `3f0b2620-d911-4b72-bf6d-2bfda6ff681c` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-3
    - `0f02f12d-c987-4e03-8c48-657ad82dee6a` = -> node_executions.id = db24c6b2-8f8f-42aa-a2cd-ab8e94410923-spec-selector
    - …其余 66 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **node_edges · execution_id · fk-orphan** × 15（已隔离，不入库）
    - `9701a620-695b-44d5-b8f8-b490e4db2534` = -> executions.id = 9bc3faf2-f966-460e-b519-a5523a713263
    - `90fed6bf-5c11-4271-a9e4-f8fdc5b8bfce` = -> executions.id = 9bc3faf2-f966-460e-b519-a5523a713263
    - `a8e92dc7-265e-4227-b536-826764448202` = -> executions.id = db24c6b2-8f8f-42aa-a2cd-ab8e94410923
    - `d43285b4-5ff3-4367-97dc-c85f0a3fde70` = -> executions.id = db24c6b2-8f8f-42aa-a2cd-ab8e94410923
    - `c8f62e1e-3f70-45a9-9bd4-2d0ed6bc4cc8` = -> executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263
    - `7e11ebc7-0ed0-4709-8007-b9dabc49fc1d` = -> executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6
    - `379badcc-f65a-4dcc-9609-c77eb8932437` = -> executions.id = b5593c0e-3830-49c4-91aa-1241dccce460
    - `2ed4e365-a2f0-4a81-8826-277290b9123d` = -> executions.id = 345620f4-9ae1-404e-8bb0-7b14278bd657
    - `bfc5c1a6-ad1f-429f-9628-566bc91c99dd` = -> executions.id = 1b783aa2-4af1-472d-875a-fa4d0b9adbb2
    - `4b3ac167-bbe5-4c33-803d-8353280be2c5` = -> executions.id = a06a3521-e8fe-48f1-91cc-a2394d03b2b4
    - …其余 5 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **node_executions · execution_id · fk-orphan** × 39（已隔离，不入库）
    - `f25fba87-beed-44f1-a1c8-1b1d73846ccd-echo-ok` = -> executions.id = f25fba87-beed-44f1-a1c8-1b1d73846ccd
    - `f25fba87-beed-44f1-a1c8-1b1d73846ccd-__engine_init__` = -> executions.id = f25fba87-beed-44f1-a1c8-1b1d73846ccd
    - `feec748f-34f0-4ffc-b36e-7608412c048f-echo-ok` = -> executions.id = feec748f-34f0-4ffc-b36e-7608412c048f
    - `feec748f-34f0-4ffc-b36e-7608412c048f-__engine_init__` = -> executions.id = feec748f-34f0-4ffc-b36e-7608412c048f
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-develop` = -> executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-ship` = -> executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-__engine_init__` = -> executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-develop` = -> executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-ship` = -> executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-__engine_init__` = -> executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6
    - …其余 29 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **node_token_usages · node_execution_id · fk-orphan** × 13（已隔离，不入库）
    - `9bc3faf2-f966-460e-b519-a5523a713263-spec-selector-token-qwen3.7-max` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-selector
    - `9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-1-token-qwen3.7-max` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-1
    - `9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-2-token-qwen3.7-max` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-2
    - `9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-3-token-qwen3.7-max` = -> node_executions.id = 9bc3faf2-f966-460e-b519-a5523a713263-spec-dag-execute:T-3
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-develop-token-qwen3.7-max[1M]` = -> node_executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263-develop
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-develop-token-qwen3.8-flash` = -> node_executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263-develop
    - `9edaf4ae-ebd2-4ae6-87fe-433ea780e263-ship-token-qwen3.7-max[1M]` = -> node_executions.id = 9edaf4ae-ebd2-4ae6-87fe-433ea780e263-ship
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-develop-token-qwen3.7-max[1M]` = -> node_executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6-develop
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-develop-token-qwen3.8-flash` = -> node_executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6-develop
    - `443b9d63-093a-4b28-9ff7-dbe5cac01fc6-ship-token-qwen3.7-max[1M]` = -> node_executions.id = 443b9d63-093a-4b28-9ff7-dbe5cac01fc6-ship
    - …其余 3 条见 /Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/20260927-kb-roadmap/p1-data-migration-report.quarantine.json
- **schedule_executions · schedule_id · fk-orphan** × 2（已隔离，不入库）
    - `241b63fb-a8c7-428d-98a8-5b7aa000950e` = -> schedules.id = 624785e6-9da8-4fc8-a781-735e52046a2f
    - `4a29bdc5-6feb-44b4-bcff-98f96380e659` = -> schedules.id = e1292c18-8846-47b9-ae36-3276b34bc979

## §4 装载后 PG 侧 FK 复核

0 孤儿 —— PG 约束视角全链路引用完整。

## §5 发现与边界

- IDENTITY 带原 id 装载 + setval 对齐: `evolution_log.id` · `experiences.id` · `insight_marks.id` · `orgs.id` · `pipeline_state.id` · `safety_events.id`
- 实际 COPY 落库行数合计: 113078
- FTS 占位表不搬迁（无消费者；pg_search 票在真表上 BM25 重建）；装载时同步清空防残留。
- [sqlite-col-not-in-pg] archive_drafts: agents：非空 0 行（全 NULL，无损）
- [sqlite-col-not-in-pg] clones: current_version_id：非空 0 行（全 NULL，无损）
- [sqlite-col-not-in-pg] schedule_workspaces: org：非空 0 行（全 NULL，无损）
- [sqlite-table-not-migrated] schedules_old_schema_backup_v37: 历史 schema 备份表
- [sqlite-table-not-migrated] schedule_executions_old_schema_backup_v37: 历史 schema 备份表
- [sqlite-table-not-migrated] schedule_audit_logs_old_schema_backup_v37: 历史 schema 备份表
- [sqlite-table-not-migrated] schedule_workspaces_old_schema_backup_v37: 历史 schema 备份表
- [sqlite-table-not-migrated] session_memory_fts: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] session_memory_fts_data: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] session_memory_fts_idx: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] session_memory_fts_content: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] session_memory_fts_docsize: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] session_memory_fts_config: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts_data: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts_idx: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts_content: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts_docsize: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] reports_fts_config: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts_data: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts_idx: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts_content: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts_docsize: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者
- [sqlite-table-not-migrated] experiences_fts_config: FTS5 家族 —— pg_search 票在真表重建，无搬迁消费者

