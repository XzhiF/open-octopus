# Octopus 模型别名配置
# 生成时间: setup
#
# tier 说明:
#   pro-max — 最强模型 (复杂推理、架构设计)
#   pro     — 主力模型 (日常开发, 默认 tier)
#   se      — 轻量模型 (简单任务、代码补全)
#
# pi provider 格式: "provider/model-id"
#   支持的 provider: anthropic, openai, dashscope, deepseek, google, mistral, xai, groq, together, fireworks
#
# claude provider 格式: 短名 (opus/sonnet/haiku), 由 ClaudeSDKProvider 内部解析
#
# 覆盖方式: 直接编辑此文件, 或创建 {orgDir}/models.yaml 做组织级覆盖

default: pro

providers:
  # Pi SDK — 多 provider 通用引擎
  pi:
    pro-max: dashscope/qwen3.7-max
    pro: dashscope/qwen3.7-plus
    se: dashscope/qwen3.6-plus

  # Claude SDK — Anthropic 直连
  claude:
    pro-max: opus
    pro: sonnet
    se: haiku
