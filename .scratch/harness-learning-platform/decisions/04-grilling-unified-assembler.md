# 04 — Unified Prompt Assembler

Type: grilling
Status: resolved
Blocked by: 02, 03

## Answer

**全部统一 SystemPromptAssembler + CloneRuntime**：
- 合并为一个统一的 Prompt Assembler 接口
- 所有 Agent 类型（主 Agent、Clone、Harness）通过同一接口组装 prompt
- Harness Agent 使用统一 assembler 加载 persona + memory + FTS 历史案例
- 消除 SystemPromptAssembler 和 CloneRuntime 的竞争关系

## Question

当前存在两个 prompt 组装系统：
- `SystemPromptAssembler.assemble()` / `.assembleForClone()` — 用于 chat sessions
- `CloneRuntime.assembleContext()` — 用于 clone chat routes

Harness Agent 还有自己的 `buildDelegationPrompt()`。

如何统一？统一粒度是什么？
