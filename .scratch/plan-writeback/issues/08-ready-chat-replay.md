# 08: 待执行对话签 — 草稿期全史只读回放

> Spec: 同 07 追加裁决轮；原型 ⓬ readyChatHtml

**What to build:** ready 控制台「💬 对话」= 该任务**草稿期会话（task.source_chat_session_id）的完整 TUI 历史**只读回放：用户/agent 气泡按到达序、thinking/工具折叠 meta 与草稿工作台同形制、顶部 dim 水印「只读回放 · 草稿期对话」；**无输入框无 dock**（要说话=回草稿或待验收期）。历史含长对话时性能不崩（既有分页/截断通路照用，如无则全量渲染并注明上限）。

**Blocked by:** 07（页签壳与装配就位）。

**Status:** done

- [x] 会话史取数 = `useAgentChat` 同源历史通路按 source_chat_session_id 拉全量消息（server 零新端点优先；确需只读聚合端点再加，加则带测试）
- [x] 渲染复用 TuiTranscript（TuiMessage+折叠 meta：thinking 全文展开、工具 input/result 展开——本会话刚做的两枚交互白拿）；只读态硬闸：不渲染输入区，且对话内容任何路径不可写
- [x] source_chat_session_id 缺失/会话已清理 → 空态文案「草稿期会话不存在」不白屏
- [x] 组件测试：三态（有史/无缝/清理态）+ 无输入框断言；07 的装配测试保持绿

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-08@f6a8ebe3；helper getAuthorSessionReplay 与草稿同端点同解析器、before 游标自持翻页≤1000 截断标注；零写通路硬闸。API 层发现：会话分页参数服务端认 before 不认 cursor，留注在案）。2026-10-10。
