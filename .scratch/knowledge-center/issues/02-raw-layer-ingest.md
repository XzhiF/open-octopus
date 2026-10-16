# 02: raw 层 + 投喂通道

**What to build:** owner 把素材投喂进知识库：URL 抓取 / 粘贴文本 / 本地文件三形态经 ingest API 落进 raw/inbox，**落盘即不可变冻结**（hash 记录）——从此编译有源可对质、可重跑。这是三层架构的层 1。

**Blocked by:** 01（Ops 前置）

**Reference:** spec §Implementation Decisions「三层架构」· prototype Tab②（目录树）Tab③（Ingest 入口 A 步骤 1-2）

**Status:** done

- [x] 三层目录骨架幂等创建：知识根 + raw/{inbox,archives,research} + wiki 五类目录
- [x] ingest API 三形态：URL 抓取（转 md）/ 粘贴文本 / 本地文件复制；产物命名 `{日期}-{slug}`，记录 origin、字节数、hash
- [x] raw 冻结契约：一切自动流程对 raw 只读；同内容重复投喂幂等（hash 相同不重复落文件，返回既有 raw 指针）
- [x] 抓取失败（404/超时/非文本）→ API 报错，raw 零落盘（不留半截源）
- [x] S1 服务层测试（真 fs + tmpdir）：命名 / hash / 幂等 / 失败零落盘 四组断言
- [x] S2 路由契约测试：三形态响应形状 + 错误码（沿用既有 errorResponse 模式）

## Comments

**2026-10-13 实现（kc/02-raw-ingest @1045b99a，commits 70ba8d65+1045b99a）**

- 新增：`services/knowledge/global-paths.ts`（全局根+骨架幂等）/ `raw.ts`（RawIngestService 三形态，sha256 冻结、同 hash 幂等回 `deduped:true`、`flag:"wx"` 永不覆盖）/ `html-to-md.ts`（零依赖转换器，未引新包）/ `routes/ingest.ts`（`POST /api/knowledge/ingest` 按 mode 分流）
- 错误码面：404→502 / 超时→504 / 非文本→415 / 无正文→422 / >5MB→413 / 非 http 协议→400，抛出点均在冻结前（零半截源）
- 命名对齐原型行 246：`2026-10-13-karpathy-llm-wiki.md` 形态
- 测试：S1 17 例 + S2 10 例 = 27/27 绿；扩面 knowledge+routes 434 passed，红仅 `archive-routes.test.ts` 预存（基线 stash 对照 8 files/44 tests 同集，**零新增红**）；build 全绿
- 真 home 复核零污染（`~/.octopus/knowledge/` 未被测试写入）
- 全局根 env 复用 `OCTOPUS_KNOWLEDGE_DIR`；org 路径链 `wiki/paths.ts` 零改动，与票 03 的重叠统一留集成后
- 边界注记（票 12 消费）：粘贴形态受全局 bodyLimit 1MB 中间件直返 413；本票零编译、不入队、无 DB 索引（查重扫 front-matter，守「raw 无共享状态」）
