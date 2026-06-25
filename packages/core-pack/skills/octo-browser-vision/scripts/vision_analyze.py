#!/usr/bin/env python3
"""vision_analyze.py — 调用 qwen3.6-plus 分析截图

用法:
    python vision_analyze.py <image_path> [question]

示例:
    python vision_analyze.py /tmp/screenshot.png
    python vision_analyze.py /tmp/screenshot.png "页面是否正常加载？"
    python vision_analyze.py /tmp/screenshot.png "列出页面上所有按钮的文本"

环境变量:
    DASHSCOPE_API_KEY — 阿里云 DashScope API Key
    如果未设置，自动从 ~/.hermes/.env 读取

降级方案:
    如果 DashScope API 调用失败，自动降级到 hermes CLI
"""

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path


def get_api_key() -> str:
    """获取 DASHSCOPE_API_KEY，优先环境变量，其次 ~/.hermes/.env"""
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if key:
        return key

    env_file = Path.home() / ".hermes" / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DASHSCOPE_API_KEY="):
                val = line.split("=", 1)[1].strip().strip("\"'")
                if val:
                    return val

    return ""


def analyze_with_dashscope(image_path: str, question: str, api_key: str) -> str:
    """调用 DashScope qwen3.6-plus API 分析图片"""
    import urllib.request
    import urllib.error

    # 读取并 base64 编码图片
    img_bytes = Path(image_path).read_bytes()
    img_b64 = base64.b64encode(img_bytes).decode("ascii")

    # 检测 MIME 类型
    ext = Path(image_path).suffix.lower()
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(ext, "image/png")

    payload = json.dumps({
        "model": "qwen3.6-plus",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime};base64,{img_b64}"
                        },
                    },
                    {
                        "type": "text",
                        "text": question,
                    },
                ],
            }
        ],
        "max_tokens": 2048,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DashScope API error {e.code}: {body}") from e
    except Exception as e:
        raise RuntimeError(f"DashScope API failed: {e}") from e


def analyze_with_hermes(image_path: str, question: str) -> str:
    """兜底方案：调用 hermes CLI 分析图片

    Hermes 内部会根据 auxiliary.vision 配置自动选择视觉模型，
    如果主模型支持 vision 则直接看图，否则用辅助视觉模型。
    无需额外 API Key 配置。
    """
    prompt = f"请分析图片 {image_path}，问题是：{question}"
    try:
        result = subprocess.run(
            ["hermes", "chat", "-q", prompt],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        raise RuntimeError(f"hermes exited with {result.returncode}: {result.stderr}")
    except FileNotFoundError:
        raise RuntimeError("hermes CLI not found in PATH — 请确保 Hermes 已安装")
    except subprocess.TimeoutExpired:
        raise RuntimeError("hermes CLI timed out after 120s")


def main():
    parser = argparse.ArgumentParser(description="分析截图内容（qwen3.6-plus）")
    parser.add_argument("image", help="图片路径")
    parser.add_argument(
        "question",
        nargs="?",
        default="请详细描述这张截图的内容，包括：页面布局、可见的元素和文本、按钮状态、是否有错误信息。用中文回答。",
        help="分析问题（默认：详细描述页面内容）",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    args = parser.parse_args()

    # 验证图片存在
    img_path = Path(args.image)
    if not img_path.is_file():
        print(f"Error: 图片不存在: {args.image}", file=sys.stderr)
        sys.exit(1)

    # 获取 API Key
    api_key = get_api_key()
    if not api_key:
        print("Warning: DASHSCOPE_API_KEY 未设置，尝试降级到 hermes CLI", file=sys.stderr)
        try:
            result = analyze_with_hermes(str(img_path), args.question)
            if args.json:
                print(json.dumps({"source": "hermes", "analysis": result}, ensure_ascii=False))
            else:
                print(result)
            return
        except RuntimeError as e:
            print(f"Error: 降级也失败: {e}", file=sys.stderr)
            sys.exit(1)

    # 优先 DashScope API
    try:
        result = analyze_with_dashscope(str(img_path), args.question, api_key)
        source = "qwen3.6-plus"
    except RuntimeError as e:
        print(f"Warning: DashScope 失败 ({e})，降级到 hermes CLI", file=sys.stderr)
        try:
            result = analyze_with_hermes(str(img_path), args.question)
            source = "hermes"
        except RuntimeError as e2:
            print(f"Error: 所有方案失败: DashScope={e}, Hermes={e2}", file=sys.stderr)
            sys.exit(1)

    # 输出结果
    if args.json:
        print(json.dumps({"source": source, "image": str(img_path), "analysis": result}, ensure_ascii=False))
    else:
        print(result)


if __name__ == "__main__":
    main()
