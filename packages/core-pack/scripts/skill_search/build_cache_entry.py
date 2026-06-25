"""
build_cache_entry.py — Generate embedding for a single Skill and update cache.

Called by Claude Code subAgent after generating a summary for a SKILL.md.
Constructs embed_input from metadata (Part 1) + model summary (Part 2),
calls DashScope text-embedding-v4 API, and writes emb_{md5(path)}.json + manifest.json.

Usage:
    python build_cache_entry.py --path "path/to/SKILL.md" --summary "Core capabilities: ..."
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Reuse Library components
from skill_searcher import (
    CACHE_VERSION,
    CACHE_MODEL,
    CACHE_DIMENSION,
    _path_to_emb_filename,
    _normalize_path,
    _split_frontmatter,
    _strip_markdown,
)


def detect_api_key() -> str | None:
    """Detect DASHSCOPE_API_KEY from ~/.env first, then system env."""
    # Try ~/.env first
    env_path = Path(os.path.expanduser("~/.env"))
    if env_path.exists():
        try:
            from dotenv import dotenv_values
            env_values = dotenv_values(str(env_path))
            if "DASHSCOPE_API_KEY" in env_values:
                return env_values["DASHSCOPE_API_KEY"]
        except ImportError:
            # python-dotenv not installed, try manual parsing
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("DASHSCOPE_API_KEY="):
                    return line.split("=", 1)[1].strip()

    # Then try system environment
    return os.environ.get("DASHSCOPE_API_KEY")


def parse_skill_md(path: str) -> dict[str, Any] | None:
    """Parse SKILL.md YAML frontmatter and extract metadata + body.

    Returns dict with: name, description, category, tags, scope, body_text, mtime.
    Returns None on parse failure.
    """
    skill_path = Path(path)
    if not skill_path.exists():
        return None

    try:
        raw = skill_path.read_text(encoding="utf-8")
    except OSError:
        return None

    mtime = skill_path.stat().st_mtime
    frontmatter, body = _split_frontmatter(raw)
    if frontmatter is None:
        return None

    try:
        import yaml
        meta = yaml.safe_load(frontmatter)
    except Exception:
        return None

    if not isinstance(meta, dict):
        return None

    body_text = _strip_markdown(body)

    return {
        "path": path,
        "name": meta.get("name", skill_path.parent.name),
        "description": meta.get("description", ""),
        "category": meta.get("category"),
        "tags": meta.get("tags", []) or [],
        "scope": meta.get("scope"),
        "body_text": body_text,
        "mtime": mtime,
    }


def build_embed_input(metadata: dict[str, Any], summary: str) -> str:
    """Construct embed_input from metadata (Part 1) + model summary (Part 2).

    Part 1: "{name}. {description}. Category: {category}. Tags: {tags_str}."
    Part 2: summary text (model-generated)
    """
    name = metadata.get("name", "")
    description = metadata.get("description", "")
    category = metadata.get("category") or ""
    tags_str = ", ".join(metadata.get("tags", []))

    part1 = f"{name}. {description}. Category: {category}. Tags: {tags_str}."
    part2 = summary

    return f"{part1} {part2}"


def call_dashscope_embedding(
    api_key: str,
    text: str,
    model: str = CACHE_MODEL,
    dimension: int = CACHE_DIMENSION,
) -> dict[str, Any]:
    """Call DashScope text-embedding-v4 API for a single document.

    Returns {"dense": [...], "sparse": [...]}.
    Raises RuntimeError on API error.
    """
    import dashscope
    from dashscope import TextEmbedding

    dashscope.api_key = api_key

    resp = TextEmbedding.call(
        model=model,
        input=[text],
        dimension=dimension,
        text_type="document",
        output_type="dense&sparse",
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"DashScope API error: status={resp.status_code}, "
            f"message={resp.message or 'unknown'}"
        )

    emb = resp.output["embeddings"][0]
    return {
        "dense": emb.get("embedding", []),
        "sparse": emb.get("sparse_embedding", []),
    }


def write_manifest_entry(cache_dir: str | None, path: str, name: str, category: str | None, embed_input: str, emb_file: str) -> None:
    """Append/update a single entry in cache/manifest.json.

    Key is normalized absolute path (forward slashes).
    Stores 4 fields: name, category, embed_input, emb_file.
    This file is for human review only — search code does not read it.
    """
    if cache_dir is None:
        cache_dir = str(Path(__file__).parent / "cache")

    manifest_path = Path(cache_dir) / "manifest.json"
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    # Load existing manifest or create fresh
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}
    else:
        manifest = {}

    # Normalize path key
    norm_path = _normalize_path(path)

    manifest[norm_path] = {
        "name": name,
        "category": category,
        "embed_input": embed_input,
        "emb_file": emb_file,
    }

    # Write back
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def cleanup_legacy_cache(cache_dir: str | None) -> None:
    """Delete legacy v2 embeddings.json and summaries.json if they exist."""
    if cache_dir is None:
        cache_dir = str(Path(__file__).parent / "cache")

    cache_dir_path = Path(cache_dir)
    (cache_dir_path / "embeddings.json").unlink(missing_ok=True)
    (cache_dir_path / "summaries.json").unlink(missing_ok=True)


def update_cache(cache_dir: str | None, path: str, entry: dict[str, Any]) -> None:
    """Write emb_{md5(path)}.json file and update manifest.json.

    emb_ file contains only: mtime, dense, sparse.
    manifest entry contains: name, category, embed_input, emb_file.
    """
    if cache_dir is None:
        cache_dir = str(Path(__file__).parent / "cache")

    # Clean up legacy files
    cleanup_legacy_cache(cache_dir)

    cache_dir_path = Path(cache_dir)
    cache_dir_path.mkdir(parents=True, exist_ok=True)

    # Write emb_ file (mtime, dense, sparse only)
    emb_filename = _path_to_emb_filename(path)
    emb_path = cache_dir_path / emb_filename
    emb_data = {
        "mtime": entry["mtime"],
        "dense": entry["dense"],
        "sparse": entry["sparse"],
    }
    emb_path.write_text(
        json.dumps(emb_data, ensure_ascii=False),
        encoding="utf-8",
    )

    # Update manifest.json
    write_manifest_entry(
        cache_dir=cache_dir,
        path=path,
        name=entry.get("name", ""),
        category=entry.get("category"),
        embed_input=entry.get("embed_input", ""),
        emb_file=emb_filename,
    )


def main() -> dict[str, Any]:
    """Main entry point. Returns result dict for JSON output."""
    parser = argparse.ArgumentParser(
        description="Generate embedding for a single Skill and update cache.",
    )
    parser.add_argument("--path", required=True, help="Path to SKILL.md file")
    parser.add_argument("--summary", required=True, help="Model-generated summary text (Part 2)")
    parser.add_argument("--cache-dir", default=None, help="Cache directory path")
    parser.add_argument("--api-key", default=None, help="DashScope API key (overrides auto-detection)")

    args = parser.parse_args()

    # Detect API key
    api_key = args.api_key or detect_api_key()
    if not api_key:
        return {
            "success": False,
            "error": "DASHSCOPE_API_KEY not found (checked ~/.env and system env)",
        }

    # Parse SKILL.md
    metadata = parse_skill_md(args.path)
    if metadata is None:
        return {
            "success": False,
            "error": f"SKILL.md not found or parse failed at {args.path}",
        }

    # Build embed_input
    embed_input = build_embed_input(metadata, args.summary)

    # Call DashScope API
    try:
        vectors = call_dashscope_embedding(api_key, embed_input)
    except RuntimeError as e:
        return {
            "success": False,
            "error": f"DashScope API error: {e}",
        }

    # Build cache entry
    entry = {
        "mtime": metadata["mtime"],
        "name": metadata["name"],
        "description": metadata["description"],
        "category": metadata["category"],
        "tags": metadata["tags"],
        "summary_text": args.summary,
        "embed_input": embed_input,
        "dense": vectors["dense"],
        "sparse": vectors["sparse"],
    }

    # Update cache (emb_ file + manifest.json)
    update_cache(args.cache_dir, metadata["path"], entry)

    return {
        "success": True,
        "path": metadata["path"],
        "name": metadata["name"],
        "embed_input_length": len(embed_input),
    }


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("success") else 1)