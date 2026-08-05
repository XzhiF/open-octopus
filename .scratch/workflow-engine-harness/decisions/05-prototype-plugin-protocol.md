# 05 — 插件注册协议：第三方怎么扩展？

Type: prototype
Status: open
Blocked by: 02

## Question

Harness 的扩展点以什么协议暴露？

候选方案：
- Express-style middleware: `engine.use(harnessPlugin)`
- Event hook: `engine.on('beforeNodeExecute', handler)`
- Strategy registration: `harness.registerDetector('stupid-retry', detector)`
- Combination: 核心用 middleware，扩展用 strategy registration

需要做一个 prototype 来验证 API 的可用性。
