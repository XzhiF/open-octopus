# 知识中心交互契约 v2：双模式与右栏跟随废除，wiki 主场 + 策展人抽屉

知识中心 v1（spec P2' · 票11/12，故事 6/7/8）把界面定成「对话模式/浏览模式」两套 grid 互斥切换 + 「右栏 wiki 跟随对话渲染（可钉住停跟随）」。验收虽全绿，owner 真用判词「反人类」：模式一切换三列全重排（对话列 3fr 比 wiki 2fr 还宽），跟随机制把你正在读的页随时被机器动作劫走——钉住钮成了用户替 AI 当门卫。三形态原型对比（wiki 主场+抽屉 ／ Wikipedia 讨论页签 ／ 命令条浮式问答，`.scratch/20261016-knowledge-center-ux/prototype.html`）收敛于第一种。

## Decision

- **双模式与跟随/钉住语义整体废除**。布局恒为 wiki 主场：左导航树 + 中正文（max-width 阅读线）+ 右栏（本页目录 · 实效账 · 反向链接）。
- **策展人只活在右侧抽屉**：overlay 盖在主场之上，开合/调宽永不重排正文；默认 560px，可拖 420px~94vw，宽度 localStorage 记忆。抽屉内 TUI 转录（ChatArea tui，任务草稿同款）+ 卡片特殊框交错渲染——呈现形制不变，只换容器。
- **多会话 = 客户端视图态**：tab 开集/active 存 localStorage；「关闭」仅收起 tab，会话本体不动（clone-session 无删除/归档/改名端点，也不为此新增）；历史=服务端 `listCloneSessions(archive)` JS 筛 `scope_id=knowledge`（chat-column 按 title 筛的既有同律）。**主通道**（title=`知识中心`）恒为唯一：夜巡/归档等机器回执的落点判据由 `title ∨ scope` **收紧为仅 title**——多会话并存后播报不漂移。手动新建会话命名 `知识中心 · N`。
- **引用药丸替代自动跳转**：卡片引用页时正文不动，页头亮「策展人刚动了 X」药丸，显式点击才渲染——`永不自动跳转` 为负断言。
- **user_preference 概念整体退役**（owner 裁决「一点用没有，彻底删除」）：UI 必读组/只读视图/AC6 测试、`GET /api/knowledge/preference` 读端点、`readUserPreference`、INDEX 重建模板必读行、策展人 persona 提及、退役 guard 的该文件半句、磁盘文件本体（移 `_archive/` 留可逆性）。SCHEMA.md 人工文件面不动。
- **随主场补齐读面**：INDEX.md 总览上树（tree 响应捎 `index` 文本，`log` 字段同律）；raw 原料库视图成为 `GET /api/knowledge/raw` 的首个客户端 importer（独立库视图不平铺进树，第一版不标编译态）；**反向链接**经编译侧把页 front-matter `links` 落库（wiki_articles 加列 + 一次性回灌），tree 读时出 `backlinks`——不引入运行时全库扫盘（wiki.ts 纪律红线）。

## Considered Options

Wikipedia「阅读/讨论」页签制：对话按页分片，斩断全局策展人通道，投喂/巡检播报无处安放——弃。命令条浮式问答（Perplexity 式）：无常驻会话面，「对话即管理」的重工作节奏不适配——弃。保留跟随为可选项：劫持读屏的问题原样复活——弃。现状最小修（只调列宽）：药丸/重排两病根未除——弃。

## Consequences

spec 故事 6/7/8/16 与票12 AC4 即日失效（原文已加废弃注，防后续 agent 按旧 AC「修回」）；`knowledge-chat.test.tsx` AC4 系、`knowledge-findings.test.tsx` 跟随断言等改写为负断言；GLOSSARY-MAP「知识中心/回填/finding/INDEX导航层/策展人/experience」词条同步改词，新增「引用药丸」「主通道」；/knowledge 首次拥有 playwright e2e（布局不被对话惊动/药丸跳转/抽屉会话动线）。
