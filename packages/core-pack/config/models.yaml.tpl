# Octopus 模型别名配置
# 生成时间: setup
#
# tier 说明:
#   pro-max — 最强模型 (复杂推理、架构设计)
#   pro     — 主力模型 (日常开发, 默认 tier)
#   se      — 轻量模型 (简单任务、代码补全)
#
# pi provider 格式: "provider/model-id"
#   内置 provider: anthropic, openai, google, mistral, xai, groq, together, fireworks
#   只需设置对应环境变量 (如 ANTHROPIC_API_KEY)
#
# 自定义 provider: 在 custom_providers 段配置 base_url + models
#   环境变量名由 env_key 指定，或默认为 {PROVIDER名大写}_API_KEY
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

# 自定义 provider 注册（非内置的 OpenAI-compatible 端点）
# 内置 provider 不需要在此配置，只需环境变量
custom_providers:
  dashscope:
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api: openai-completions
    env_key: DASHSCOPE_API_KEY
    models:
      - id: qwen3.7-max
        name: Qwen 3.7 Max
        context_window: 131072
        max_tokens: 16384
      - id: qwen3.7-plus
        name: Qwen 3.7 Plus
        context_window: 131072
        max_tokens: 16384
      - id: qwen3.6-plus
        name: Qwen 3.6 Plus
        context_window: 131072
        max_tokens: 16384

  # ─── 扩展示例（取消注释并配置使用）───
  # deepseek:
  #   base_url: https://api.deepseek.com/v1
  #   api: openai-completions
  #   models:
  #     - id: deepseek-chat
  #       name: DeepSeek Chat
  #       context_window: 65536
  #       max_tokens: 8192
