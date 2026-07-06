# Models 配置扩展设计

> 让用户通过 `models.yaml` 添加任意 OpenAI-compatible provider，无需改代码。

---

## 设计目标

1. 用户在 `models.yaml` 里声明 provider（baseUrl + api 协议 + 模型列表）
2. Adapter 加载配置，自动注册到 Pi SDK ModelRegistry
3. 内置 provider（anthropic、openai 等）只需 API Key，不需要配置
4. 向后兼容：现有 `EXTRA_PROVIDERS` 作为 fallback，YAML 配置优先覆盖

## YAML 结构

```yaml
# ~/.octopus/models.yaml

default: pro

# ─── Tier 别名（现有功能，不变）───
providers:
  pi:
    pro-max: dashscope/qwen3.7-max
    pro: dashscope/qwen3.7-plus
    se: dashscope/qwen3.6-plus
  claude:
    pro-max: opus
    pro: sonnet
    se: haiku

# ─── Provider 注册（新增）───
# 用于非内置的 OpenAI-compatible provider
# 内置 provider（anthropic/openai/google 等）不需要在这里配置，只需环境变量
custom_providers:
  dashscope:
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api: openai-completions
    env_key: DASHSCOPE_API_KEY          # 环境变量名（可选，默认大写 provider_name + _API_KEY）
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

  # ─── 扩展示例：DeepSeek ───
  deepseek:
    base_url: https://api.deepseek.com/v1
    api: openai-completions
    models:
      - id: deepseek-chat
        name: DeepSeek Chat
        context_window: 65536
        max_tokens: 8192
      - id: deepseek-reasoner
        name: DeepSeek Reasoner
        reasoning: true
        context_window: 65536
        max_tokens: 8192

  # ─── 扩展示例：本地 Ollama ───
  ollama:
    base_url: http://localhost:11434/v1
    api: openai-completions
    env_key: OLLAMA_API_KEY             # 本地可以设空值
    models:
      - id: llama3.1:70b
        name: Llama 3.1 70B
        context_window: 131072
        max_tokens: 4096
```

## 字段说明

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `base_url` | ✅ | — | API 端点 |
| `api` | ✅ | — | API 协议，目前只支持 `openai-completions` |
| `env_key` | ❌ | `{PROVIDER_NAME}_API_KEY`（大写） | 环境变量名 |
| `models[].id` | ✅ | — | 模型 ID（API 使用的标识） |
| `models[].name` | ❌ | 同 id | 显示名称 |
| `models[].context_window` | ❌ | 32768 | 上下文窗口大小 |
| `models[].max_tokens` | ❌ | 8192 | 最大输出 tokens |
| `models[].reasoning` | ❌ | false | 是否推理模型 |
| `models[].cost` | ❌ | 全 0 | `{ input, output, cacheRead, cacheWrite }` |

## 加载流程

```
models.yaml 加载
  → 解析 custom_providers 段
  → 对每个 provider:
    1. 从 env 取 API Key（env_key 或默认）
    2. 无 key → 跳过（不报错，只是不可用）
    3. 有 key → 注册到 ModelRegistry
  → 与 EXTRA_PROVIDERS 合并（YAML 优先覆盖同名 provider）
```

## 改动范围

| 文件 | 改动 |
|------|------|
| `shared/src/config/model-alias.ts` | Schema 加 `custom_providers` 段 |
| `providers/src/pi/pi-sdk-adapter.ts` | `registerProvidersFromEnv` 接受外部 provider 配置 |
| `providers/src/pi/provider.ts` | 加载 `custom_providers` 传给 adapter |

预计 ~50 行改动，不影响现有功能。
