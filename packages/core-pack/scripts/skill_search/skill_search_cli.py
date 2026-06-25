"""
Skill Search CLI — command-line interface for SkillSearcher.

Provides search, eval, and build-cache commands with JSON output for Claude Agent.

Dual-engine: Hybrid Embedding (DashScope text-embedding-v4) when DASHSCOPE_API_KEY
available, BM25 three-layer fallback when not.

API KEY detection: ~/.env file first → system environment variable → BM25 fallback.

Usage:
    python skill_search_cli.py search --query "排查K8s Pod异常"
    python skill_search_cli.py search --query "env config" --dirs ".claude/skills" --top-k 5
    python skill_search_cli.py build-cache [--dirs ".claude/skills"]
    python skill_search_cli.py eval --queries "q1,q2" --expected "skill1,skill2" --strategies "truncate,summary"
"""

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from skill_searcher import (
    CACHE_VERSION,
    CACHE_MODEL,
    CACHE_DIMENSION,
    HYBRID_WEIGHTS,
    EMBEDDING_BATCH_SIZE,
    SkillCollector,
    SkillDocument,
    EmbeddingEngine,
    BM25Engine,
    CacheManager,
    SkillSearcher,
    _cosine_similarity,
    _sparse_similarity,
    _path_to_emb_filename,
)
from build_cache_entry import write_manifest_entry, _path_to_emb_filename as build_path_to_emb


def detect_api_key() -> str | None:
    """Detect DASHSCOPE_API_KEY: ~/.env first, then system env."""
    # Load ~/.env file first
    env_path = Path.home() / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=False)

    return os.environ.get("DASHSCOPE_API_KEY")


def output_json(data: dict, success: bool = True) -> None:
    """Print structured JSON result for Claude Agent parsing."""
    result = {"success": success, "data": data}
    print(json.dumps(result, ensure_ascii=False, indent=2))


def output_error(message: str) -> None:
    """Print error as JSON and exit."""
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False, indent=2))
    sys.exit(1)


def cmd_search(args: argparse.Namespace) -> None:
    """Execute skill search with automatic engine selection."""
    api_key = detect_api_key()

    warnings_note = ""
    if not api_key:
        warnings_note = "DASHSCOPE_API_KEY not found, using BM25 fallback"

    if args.dirs:
        dirs = args.dirs.split(",")
    else:
        # Default: cwd absolute path + home absolute path (never relative paths)
        dirs = [
            str(Path.cwd() / ".claude" / "skills"),
            str(Path.home() / ".claude" / "skills"),
        ]

    try:
        searcher = SkillSearcher(api_key=api_key)
        result = searcher.search(
            query=args.query,
            dirs=dirs,
            top_k=args.top_k,
        )

        # Add fallback warning if applicable
        if warnings_note:
            result["warnings"] = result.get("warnings", []) + [warnings_note]

        output_json(result)

    except Exception as e:
        output_error(str(e))


def cmd_build_cache(args: argparse.Namespace) -> None:
    """Build embedding cache for all Skills using build_cache_entry.py logic.

    For each Skill: parse metadata, construct embed_input with placeholder summary,
    call DashScope API, write to cache.

    Note: This uses a basic metadata-only summary. For model-generated summaries,
    use Claude Code subAgent with build_cache_entry.py instead.
    """
    api_key = detect_api_key()
    if not api_key:
        output_error("DASHSCOPE_API_KEY not found, cannot build embedding cache")

    dirs = args.dirs.split(",") if args.dirs else None

    try:
        collector = SkillCollector()
        docs, warnings = collector.collect(dirs)

        if not docs:
            output_json({"skills_processed": 0, "cache_path": "", "warnings": warnings})
            return

        engine = EmbeddingEngine(api_key=api_key)
        cache_mgr = CacheManager()

        # For build-cache without subAgent, use metadata-only embed_input
        # (no model summary available — just Part 1 from metadata)
        new_vectors: dict[str, dict[str, Any]] = {}
        errors: list[str] = []

        for doc in docs:
            # Build Part 1 from metadata (no summary available in batch mode)
            name = doc.name
            description = doc.description
            category = doc.category or ""
            tags_str = ", ".join(doc.tags)
            embed_input = f"{name}. {description}. Category: {category}. Tags: {tags_str}."
            summary_text = ""  # No model summary in batch mode

            try:
                vecs = engine.embed_documents([embed_input])
                new_vectors[doc.path] = {
                    "mtime": doc.mtime,
                    "name": doc.name,
                    "description": doc.description,
                    "category": doc.category,
                    "tags": doc.tags,
                    "summary_text": summary_text,
                    "embed_input": embed_input,
                    "dense": vecs[0]["dense"],
                    "sparse": vecs[0]["sparse"],
                }
            except RuntimeError as e:
                errors.append(f"Embedding failed for {doc.name}: {e}")

        # Update cache (writes emb_ files + manifest.json)
        all_vectors = cache_mgr.update_cache(docs, new_vectors)

        output_json({
            "skills_processed": len(new_vectors),
            "cache_dir": str(cache_mgr.cache_dir),
            "errors": errors,
            "warnings": warnings,
            "note": "Metadata-only embed_input (no model summary). Use subAgent + build_cache_entry.py for summary-based cache.",
        })

    except Exception as e:
        output_error(str(e))


def cmd_eval(args: argparse.Namespace) -> None:
    """Compare search quality across different embed_input strategies."""
    api_key = detect_api_key()
    if not api_key:
        output_error("DASHSCOPE_API_KEY not found, cannot run eval (requires embedding)")

    queries = args.queries.split(",")
    expected = args.expected.split(",")
    strategies = args.strategies.split(",")
    dirs = args.dirs.split(",") if args.dirs else None

    try:
        collector = SkillCollector()
        docs, warnings = collector.collect(dirs)

        if not docs:
            output_error("No Skills found for eval")

        engine = EmbeddingEngine(api_key=api_key)
        results: dict[str, list[dict[str, Any]]] = {}

        for strategy in strategies:
            strategy_results: list[dict[str, Any]] = []

            # Build vectors for this strategy
            strategy_vectors: dict[str, dict[str, Any]] = {}

            for doc in docs:
                if strategy == "truncate":
                    # Old strategy: truncate description + body_text at 4000 chars
                    embed_input = (doc.description + " " + doc.body_text)[:4000]
                elif strategy == "summary":
                    # New strategy: use cached embed_input from embeddings.json
                    cache_mgr = CacheManager()
                    cached = cache_mgr.get_cached_vectors(docs)
                    cached_entry = cached.get(doc.path)
                    if cached_entry and cached_entry.get("embed_input"):
                        embed_input = cached_entry["embed_input"]
                    else:
                        # Fallback to metadata-only if no cached summary
                        name = doc.name
                        description = doc.description
                        category = doc.category or ""
                        tags_str = ", ".join(doc.tags)
                        embed_input = f"{name}. {description}. Category: {category}. Tags: {tags_str}."
                else:
                    output_error(f"Unknown strategy: {strategy}")

                try:
                    vecs = engine.embed_documents([embed_input])
                    strategy_vectors[doc.path] = vecs[0]
                except RuntimeError:
                    pass  # Skip failed embeddings

            # Run search for each query
            top1_correct = 0
            score_deltas: list[float] = []

            for i, query in enumerate(queries):
                expected_name = expected[i] if i < len(expected) else ""

                query_vec = engine.embed_query(query)
                query_dense = query_vec["dense"]
                query_sparse = query_vec["sparse"]

                scores: list[tuple[SkillDocument, float]] = []
                for doc in docs:
                    cached = strategy_vectors.get(doc.path)
                    if not cached:
                        continue
                    dense_sim = _cosine_similarity(query_dense, cached["dense"])
                    sparse_sim = _sparse_similarity(query_sparse, cached["sparse"])
                    hybrid_score = (
                        HYBRID_WEIGHTS["dense"] * dense_sim
                        + HYBRID_WEIGHTS["sparse"] * sparse_sim
                    )
                    scores.append((doc, hybrid_score))

                ranked = sorted(scores, key=lambda x: x[1], reverse=True)
                top3_names = [d.name for d, s in ranked[:3]]

                if ranked:
                    top1_name = ranked[0][0].name
                    if top1_name == expected_name:
                        top1_correct += 1

                    if len(ranked) >= 2:
                        delta = ranked[0][1] - ranked[1][1]
                        score_deltas.append(delta)

                strategy_results.append({
                    "query": query,
                    "expected": expected_name,
                    "top3": top3_names,
                    "top3_scores": [round(s, 4) for d, s in ranked[:3]],
                })

            # Calculate sparse coverage
            sparse_tokens_all: set[str] = set()
            for doc in docs:
                cached = strategy_vectors.get(doc.path)
                if cached and "sparse" in cached:
                    for token_entry in cached["sparse"]:
                        if isinstance(token_entry, dict) and "token" in token_entry:
                            sparse_tokens_all.add(token_entry["token"])

            results[strategy] = [
                {
                    "name": strategy,
                    "top1_accuracy": f"{top1_correct}/{len(queries)}",
                    "avg_score_delta": round(sum(score_deltas) / len(score_deltas), 4) if score_deltas else 0,
                    "sparse_token_count": len(sparse_tokens_all),
                },
                strategy_results,
            ]

        # Format final output
        output_data: dict[str, Any] = {
            "strategies": [],
            "queries": [],
        }

        for strategy, items in results.items():
            summary = items[0]
            query_details = items[1]
            output_data["strategies"].append(summary)
            output_data["queries"].append({
                "strategy": strategy,
                "results": query_details,
            })

        output_json(output_data)

    except Exception as e:
        output_error(str(e))


def build_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Skill Search CLI — dual-engine search for local Claude Skills",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # search
    search_p = subparsers.add_parser("search", help="Search local Skills")
    search_p.add_argument("--query", required=True,
                          help="Search query (e.g., 'K8s Pod troubleshoot')")
    search_p.add_argument("--dirs", default=None,
                          help="Comma-separated directories (default: .claude/skills,~/.claude/skills)")
    search_p.add_argument("--top-k", type=int, default=5,
                          help="Number of results to return (default: 5)")

    # build-cache
    build_p = subparsers.add_parser("build-cache", help="Build embedding cache for all Skills")
    build_p.add_argument("--dirs", default=None,
                          help="Comma-separated directories (default: .claude/skills,~/.claude/skills)")

    # eval
    eval_p = subparsers.add_parser("eval", help="Compare search quality across strategies")
    eval_p.add_argument("--queries", required=True,
                        help="Comma-separated search queries")
    eval_p.add_argument("--expected", required=True,
                        help="Comma-separated expected top-1 Skill names")
    eval_p.add_argument("--strategies", default="truncate,summary",
                        help="Comma-separated strategies to compare (default: truncate,summary)")
    eval_p.add_argument("--dirs", default=None,
                        help="Comma-separated directories")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "build-cache":
        cmd_build_cache(args)
    elif args.command == "eval":
        cmd_eval(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()