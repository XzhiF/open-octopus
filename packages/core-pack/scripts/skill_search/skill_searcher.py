"""
Skill Search Engine — dual-engine search for local Claude Skills.

Library layer (pure algorithm, no environment config):
- SkillCollector: Phase A data collection (walk dirs, read/parse SKILL.md)
- BM25Engine: BM25 three-layer scoring fallback (k1=1.2, b=0.75)
- EmbeddingEngine: DashScope text-embedding-v4 dense&sparse hybrid search
- CacheManager: Local embeddings.json cache with mtime incremental update
- SkillSearcher: Orchestrator combining all components

Usage:
    searcher = SkillSearcher(api_key="sk-xxx")
    result = searcher.search(query="K8s Pod troubleshoot", dirs=[".claude/skills"])
    # result = {"engine": "hybrid-embedding", "results": [...], "warnings": [...]}
"""

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class SkillDocument:
    """Parsed SKILL.md document for search."""
    path: str
    name: str
    description: str
    category: str | None = None
    tags: list[str] = field(default_factory=list)
    scope: str | None = None
    body_text: str = ""
    mtime: float = 0.0
    summary_text: str | None = None
    embed_input: str | None = None

    @property
    def search_text(self) -> str:
        """BM25 search text: description + body (used by BM25 engine only)."""
        return f"{self.description} {self.body_text}"


@dataclass
class SearchResult:
    """Single search result entry."""
    name: str
    path: str
    score: float
    rank: int
    relevance: str = "none"


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "troubleshooting": [
        "debug", "troubleshoot", "diagnose", "investigate", "fix",
        "error", "issue", "problem", "排查", "诊断", "修复",
    ],
    "process-guide": [
        "deploy", "release", "approve", "workflow", "process",
        "pipeline", "checklist", "发布", "审批", "流程",
    ],
    "coding-assistant": [
        "generate", "refactor", "code", "implement", "write",
        "review", "编码", "生成", "重构",
    ],
    "sop": [
        "sop", "procedure", "operation", "standard", "compliance",
        "规程", "标准", "操作",
    ],
}

STOP_WORDS: set[str] = {
    "a", "an", "the", "is", "of", "in", "on", "at", "to", "for",
    "and", "or", "but", "with", "by", "from", "this", "that",
}

DEFAULT_DIRS: list[str] = []  # Empty default — caller should provide absolute paths (cwd + home)

CACHE_VERSION: int = 3
CACHE_MODEL: str = "text-embedding-v4"
CACHE_DIMENSION: int = 1024

HYBRID_WEIGHTS: dict[str, float] = {
    "dense": 0.7,
    "sparse": 0.3,
}

EMBEDDING_BATCH_SIZE: int = 10

# Relevance level thresholds per engine
RELEVANCE_THRESHOLDS: dict[str, dict[str, float]] = {
    "hybrid-embedding": {
        "high": 0.70,     # cosine/sparse hybrid ≥ 0.70
        "medium": 0.40,   # ≥ 0.40
        "low": 0.15,      # ≥ 0.15
    },
    "bm25-three-layer": {
        "high": 15.0,     # BM25 + cat + tag ≥ 15
        "medium": 5.0,    # ≥ 5
        "low": 1.0,       # ≥ 1
    },
}


def classify_relevance(score: float, engine: str) -> str:
    """Classify score into relevance level: high, medium, low, none."""
    thresholds = RELEVANCE_THRESHOLDS.get(engine, {})
    if score >= thresholds.get("high", float("inf")):
        return "high"
    if score >= thresholds.get("medium", 0):
        return "medium"
    if score >= thresholds.get("low", 0):
        return "low"
    return "none"


# ---------------------------------------------------------------------------
# SkillCollector — Phase A: file collection & parsing
# ---------------------------------------------------------------------------

class SkillCollector:
    """Walk directories, find SKILL.md files, parse frontmatter and body."""

    def collect(self, dirs: list[str] | None = None) -> tuple[list[SkillDocument], list[str]]:
        """Collect Skill documents from directories.

        Returns (skill_docs, warnings).
        """
        if dirs is None:
            dirs = DEFAULT_DIRS

        skill_docs: list[SkillDocument] = []
        warnings: list[str] = []

        skill_files = self._find_skill_files(dirs)
        for path in skill_files:
            doc, warning = self._parse_skill_file(path)
            if doc:
                skill_docs.append(doc)
            if warning:
                warnings.append(warning)

        return skill_docs, warnings

    def _find_skill_files(self, dirs: list[str]) -> list[str]:
        """Walk directories to find **/SKILL.md files."""
        found: list[str] = []
        for dir_path in dirs:
            expanded = self._expand_path(dir_path)
            if not expanded.exists():
                continue
            for p in expanded.rglob("SKILL.md"):
                found.append(str(p))
        return found

    @staticmethod
    def _expand_path(path: str) -> Path:
        """Expand ~ and resolve path."""
        return Path(os.path.expanduser(path))

    @staticmethod
    def _parse_skill_file(path: str) -> tuple[SkillDocument | None, str | None]:
        """Parse a SKILL.md file into a SkillDocument.

        Returns (doc, warning). doc is None on parse failure.
        """
        try:
            raw = Path(path).read_text(encoding="utf-8")
        except OSError as e:
            return None, f"Failed to read {path}: {e}"

        mtime = Path(path).stat().st_mtime

        frontmatter, body = _split_frontmatter(raw)
        if frontmatter is None:
            return None, f"Failed to parse YAML frontmatter in {path}"

        try:
            import yaml
            meta = yaml.safe_load(frontmatter)
        except Exception:
            return None, f"Failed to parse YAML in {path}"

        if not isinstance(meta, dict):
            return None, f"YAML frontmatter is not a dict in {path}"

        # Strip markdown formatting from body for search text
        body_text = _strip_markdown(body)

        doc = SkillDocument(
            path=path,
            name=meta.get("name", Path(path).parent.name),
            description=meta.get("description", ""),
            category=meta.get("category"),
            tags=meta.get("tags", []) or [],
            scope=meta.get("scope"),
            body_text=body_text,
            mtime=mtime,
        )
        return doc, None


def _split_frontmatter(raw: str) -> tuple[str | None, str]:
    """Split SKILL.md content into YAML frontmatter and body.

    Returns (frontmatter_str, body_str). frontmatter is None if not found.
    """
    if not raw.startswith("---"):
        return None, raw

    # Find second "---" marker (after the opening one)
    # The opening "---" may be followed by optional whitespace/newline
    rest = raw[3:]
    # Skip leading whitespace after first ---
    rest_stripped = rest.lstrip("\n\r")

    # Find second "---" marker
    end_match = re.search(r"\n---\s*\n", rest_stripped)
    if not end_match:
        return None, raw

    frontmatter = rest_stripped[:end_match.start()]
    body = rest_stripped[end_match.end():]
    return frontmatter, body


def _strip_markdown(text: str) -> str:
    """Strip markdown formatting for plain text search."""
    text = re.sub(r"```[\s\S]*?```", "", text)  # code blocks
    text = re.sub(r"<!--[\s\S]*?-->", "", text)   # HTML comments
    text = re.sub(r"#+\s", "", text)              # headings
    text = re.sub(r"\*+([^*]+)\*+", r"\1", text)  # bold/italic
    text = re.sub(r"`([^`]+)`", r"\1", text)      # inline code
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # links
    text = re.sub(r"^[>\-|]\s?", "", text, flags=re.MULTILINE)  # quotes/lists
    return text.strip()


# ---------------------------------------------------------------------------
# BM25Engine — Three-layer scoring fallback
# ---------------------------------------------------------------------------

class BM25Engine:
    """BM25 three-layer scoring: Category ×10 + Tags ×3 + BM25 text."""

    K1: float = 1.2
    B: float = 0.75

    def search(
        self,
        query: str,
        docs: list[SkillDocument],
        top_k: int = 5,
    ) -> list[SearchResult]:
        """Execute BM25 three-layer search."""
        if not docs:
            return []

        query_tokens = tokenize(query)

        # Pre-compute BM25 corpus stats
        N = len(docs)
        all_doc_tokens = [tokenize(d.search_text) for d in docs]
        df: dict[str, int] = {}
        for tokens in all_doc_tokens:
            for t in set(tokens):
                df[t] = df.get(t, 0) + 1
        avgdl = sum(len(t) for t in all_doc_tokens) / N if N > 0 else 1.0

        # Layer 1: Category match
        inferred_category = infer_category(query)
        category_scores = [
            10.0 if d.category == inferred_category else 0.0
            for d in docs
        ]

        # Layer 2: Tags match
        tag_scores = [
            3.0 * count_tag_matches(query_tokens, d.tags)
            for d in docs
        ]

        # Layer 3: BM25 text relevance
        bm25_scores = [
            self._bm25_score(query_tokens, all_doc_tokens[i], df, N, avgdl)
            for i in range(len(docs))
        ]

        # Combined score
        final_scores = [
            bm25_scores[i] + category_scores[i] + tag_scores[i]
            for i in range(len(docs))
        ]

        # Sort and return top-K
        ranked = sorted(
            zip(docs, final_scores),
            key=lambda x: x[1],
            reverse=True,
        )[:top_k]

        return [
            SearchResult(
                name=d.name, path=d.path, score=round(s, 4), rank=i + 1,
                relevance=classify_relevance(s, "bm25-three-layer"),
            )
            for i, (d, s) in enumerate(ranked)
        ]

    def _bm25_score(
        self,
        query_tokens: list[str],
        doc_tokens: list[str],
        df: dict[str, int],
        N: int,
        avgdl: float,
    ) -> float:
        """Calculate BM25 score for a single document."""
        dl = len(doc_tokens)
        tf_map: dict[str, int] = {}
        for t in doc_tokens:
            tf_map[t] = tf_map.get(t, 0) + 1

        score = 0.0
        for q in query_tokens:
            tf = tf_map.get(q, 0)
            if tf == 0:
                continue
            df_q = df.get(q, 0)
            idf = math.log((N - df_q + 0.5) / (df_q + 0.5) + 1)
            tf_component = (tf * (self.K1 + 1)) / (
                tf + self.K1 * (1 - self.B + self.B * dl / avgdl)
            )
            score += idf * tf_component
        return score


def tokenize(text: str) -> list[str]:
    """Tokenize text for BM25: CJK-ASCII boundary split, camelCase split, lowercase, stop words."""
    # 1. Insert spaces at CJK ↔ ASCII boundaries before any other processing
    #    e.g., "排查K8s" → "排查 K8s", "Pod异常" → "Pod 异常"
    text = re.sub(r"([\u4e00-\u9fff])([a-zA-Z0-9])", r"\1 \2", text)
    text = re.sub(r"([a-zA-Z0-9])([\u4e00-\u9fff])", r"\1 \2", text)
    # 2. Split camelCase BEFORE lowercasing (need case difference to detect boundaries)
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", text)
    # 3. Now lowercase
    text = text.lower()
    # 4. Split hyphenated
    text = text.replace("-", " ")
    # 5. Split by whitespace and punctuation
    tokens = re.split(r"[\s\n\r,.;:!?()/\\\"']+", text)
    # 6. Remove stop words and empty
    tokens = [t for t in tokens if t and t not in STOP_WORDS]
    return tokens


def infer_category(query: str) -> str | None:
    """Infer category from query keywords using category_keywords mapping."""
    query_lower = query.lower()
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in query_lower:
                return cat
    return None


def count_tag_matches(query_tokens: list[str], tags: list[str]) -> int:
    """Count how many query tokens match document tags."""
    tags_lower = {t.lower() for t in tags}
    return sum(1 for t in query_tokens if t in tags_lower)


# ---------------------------------------------------------------------------
# EmbeddingEngine — DashScope text-embedding-v4 dense&sparse
# ---------------------------------------------------------------------------

class EmbeddingEngine:
    """Hybrid Embedding search using DashScope text-embedding-v4 dense+sparse."""

    def __init__(
        self,
        api_key: str,
        model: str = CACHE_MODEL,
        dimension: int = CACHE_DIMENSION,
        weights: dict[str, float] | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.dimension = dimension
        self.weights = weights or HYBRID_WEIGHTS

    def embed_documents(
        self,
        texts: list[str],
    ) -> list[dict[str, Any]]:
        """Embed documents with text_type="document", output_type="dense&sparse".

        Batches in groups of EMBEDDING_BATCH_SIZE (10).
        Returns list of {"dense": [...], "sparse": [{"index", "value", "token"}, ...]}.
        """
        results: list[dict[str, Any]] = []
        for batch in _batch(texts, EMBEDDING_BATCH_SIZE):
            resp = self._call_api(batch, text_type="document")
            for emb in resp:
                results.append(emb)
        return results

    def embed_query(self, text: str) -> dict[str, Any]:
        """Embed query with text_type="query", output_type="dense&sparse".

        Not cached — real-time computation.
        """
        resp = self._call_api([text], text_type="query")
        return resp[0]

    def search(
        self,
        query: str,
        docs: list[SkillDocument],
        cached_vectors: dict[str, dict[str, Any]],
        top_k: int = 5,
    ) -> list[SearchResult]:
        """Execute hybrid embedding search.

        Uses cached_vectors for document embeddings, live API call for query.
        """
        query_vec = self.embed_query(query)
        query_dense = query_vec["dense"]
        query_sparse = query_vec["sparse"]

        scores: list[tuple[SkillDocument, float]] = []
        for doc in docs:
            cached = cached_vectors.get(doc.path)
            if not cached:
                continue

            dense_sim = _cosine_similarity(query_dense, cached["dense"])
            sparse_sim = _sparse_similarity(query_sparse, cached["sparse"])
            hybrid_score = (
                self.weights["dense"] * dense_sim
                + self.weights["sparse"] * sparse_sim
            )
            scores.append((doc, hybrid_score))

        ranked = sorted(scores, key=lambda x: x[1], reverse=True)[:top_k]

        return [
            SearchResult(
                name=d.name, path=d.path, score=round(s, 4), rank=i + 1,
                relevance=classify_relevance(s, "hybrid-embedding"),
            )
            for i, (d, s) in enumerate(ranked)
        ]

    def _call_api(
        self,
        texts: list[str],
        text_type: str,
    ) -> list[dict[str, Any]]:
        """Call DashScope native TextEmbedding API.

        Returns list of {"dense": [...], "sparse": [{"index", "value", "token"}, ...]}.
        """
        import dashscope
        from dashscope import TextEmbedding

        dashscope.api_key = self.api_key

        resp = TextEmbedding.call(
            model=self.model,
            input=texts,
            dimension=self.dimension,
            text_type=text_type,
            output_type="dense&sparse",
        )

        if resp.status_code != 200:
            raise RuntimeError(
                f"DashScope API error: status={resp.status_code}, "
                f"message={resp.message or 'unknown'}"
            )

        results: list[dict[str, Any]] = []
        for emb in resp.output["embeddings"]:
            dense = emb.get("embedding", [])
            sparse = emb.get("sparse_embedding", [])
            results.append({"dense": dense, "sparse": sparse})
        return results


def _batch(items: list, size: int) -> list[list]:
    """Split items into batches of given size."""
    return [items[i:i + size] for i in range(0, len(items), size)]


def _normalize_path(path: str) -> str:
    """Normalize path to forward slashes for cross-platform cache lookup."""
    return path.replace("\\", "/")


def _path_to_emb_filename(path: str) -> str:
    """Convert a Skill path to its emb_ cache filename.

    Normalizes path to forward slashes, then computes MD5 hex digest.
    Returns 'emb_{md5_hex}.json'.
    """
    norm = _normalize_path(path)
    md5_hex = hashlib.md5(norm.encode("utf-8")).hexdigest()
    return f"emb_{md5_hex}.json"


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two dense vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _sparse_similarity(
    sparse_q: list[dict[str, Any]],
    sparse_d: list[dict[str, Any]],
) -> float:
    """Compute normalized dot product between two sparse vectors.

    Each sparse vector is [{"index": int, "value": float, "token": str}, ...].
    """
    q_dict = {s["token"]: s["value"] for s in sparse_q}
    d_dict = {s["token"]: s["value"] for s in sparse_d}

    # Dot product over intersection
    intersection = q_dict.keys() & d_dict.keys()
    dot = sum(q_dict[t] * d_dict[t] for t in intersection)

    # L2 norms
    q_norm = math.sqrt(sum(v ** 2 for v in q_dict.values()))
    d_norm = math.sqrt(sum(v ** 2 for v in d_dict.values()))

    if q_norm == 0 or d_norm == 0:
        return 0.0
    return dot / (q_norm * d_norm)


# ---------------------------------------------------------------------------
# CacheManager — per-Skill emb_{md5}.json with mtime incremental update
# ---------------------------------------------------------------------------

class CacheManager:
    """Manage per-Skill emb_{md5(path)}.json cache with mtime-based incremental updates.

    Each Skill's vectors are stored in an independent emb_ file.
    manifest.json is maintained as a human-readable record (not read by search code).
    Legacy embeddings.json and summaries.json are automatically cleaned up.
    """

    def __init__(self, cache_dir: str | None = None) -> None:
        if cache_dir is None:
            cache_dir = str(
                Path(__file__).parent / "cache"
            )
        self.cache_dir = Path(cache_dir)
        self.manifest_path = self.cache_dir / "manifest.json"

    def _cleanup_legacy_cache(self) -> None:
        """Delete legacy v2 embeddings.json and summaries.json if they exist."""
        legacy_emb = self.cache_dir / "embeddings.json"
        legacy_sum = self.cache_dir / "summaries.json"
        legacy_emb.unlink(missing_ok=True)
        legacy_sum.unlink(missing_ok=True)

    def _write_emb_file(self, path: str, entry: dict[str, Any]) -> None:
        """Write a single emb_{md5}.json file for a Skill.

        entry must contain: mtime, dense, sparse.
        Only these 3 fields are stored in the emb_ file.
        """
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        emb_file = _path_to_emb_filename(path)
        emb_path = self.cache_dir / emb_file
        emb_data = {
            "mtime": entry["mtime"],
            "dense": entry["dense"],
            "sparse": entry["sparse"],
        }
        emb_path.write_text(
            json.dumps(emb_data, ensure_ascii=False),
            encoding="utf-8",
        )

    def _write_manifest_entry(
        self,
        path: str,
        name: str,
        category: str | None,
        embed_input: str,
        emb_file: str,
    ) -> None:
        """Update a single entry in manifest.json.

        manifest.json stores: {path: {name, category, embed_input, embed_file}}
        """
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # Load existing manifest or create fresh
        if self.manifest_path.exists():
            try:
                manifest = json.loads(
                    self.manifest_path.read_text(encoding="utf-8")
                )
            except (json.JSONDecodeError, OSError):
                manifest = {}
        else:
            manifest = {}

        norm_path = _normalize_path(path)
        manifest[norm_path] = {
            "name": name,
            "category": category,
            "embed_input": embed_input,
            "emb_file": emb_file,
        }

        self.manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def get_cached_vectors(self, docs: list[SkillDocument]) -> dict[str, dict[str, Any]]:
        """Get cached vectors for documents whose mtime matches.

        For each doc, computes emb_{md5(doc.path)}.json filename,
        checks if the file exists, reads it, and compares mtime.
        Returns {path: {"mtime": ..., "dense": [...], "sparse": [...], ...}} for valid entries.
        """
        # Clean up legacy files first
        self._cleanup_legacy_cache()

        valid: dict[str, dict[str, Any]] = {}

        for doc in docs:
            emb_file = _path_to_emb_filename(doc.path)
            emb_path = self.cache_dir / emb_file

            if not emb_path.exists():
                continue

            try:
                emb_data = json.loads(
                    emb_path.read_text(encoding="utf-8")
                )
            except (json.JSONDecodeError, OSError):
                # Corrupted emb_ file — delete and skip
                emb_path.unlink(missing_ok=True)
                continue

            if emb_data.get("mtime") != doc.mtime:
                continue

            # Validate dense vector dimension
            dense = emb_data.get("dense", [])
            if len(dense) != CACHE_DIMENSION:
                # Dimension mismatch — delete all emb_ files, trigger full rebuild
                self._delete_all_emb_files()
                return {}

            valid[doc.path] = emb_data

        return valid

    def update_cache(
        self,
        docs: list[SkillDocument],
        new_vectors: dict[str, dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        """Update cache: write new emb_ files, remove stale entries, update manifest.

        Returns dict of all current vectors {path: {mtime, dense, sparse, ...}}.
        """
        # Clean up legacy files first
        self._cleanup_legacy_cache()
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        current_paths = {_normalize_path(d.path) for d in docs}

        # Remove stale emb_ files: those whose Skill path is no longer on disk
        for emb_file in self.cache_dir.glob("emb_*.json"):
            # Reverse-lookup: check if this emb_ file corresponds to a current Skill
            # We can't reverse MD5, so we check via manifest
            emb_filename = emb_file.name
            is_current = False

            # Load manifest to check if this emb_ file is referenced
            manifest = {}
            if self.manifest_path.exists():
                try:
                    manifest = json.loads(
                        self.manifest_path.read_text(encoding="utf-8")
                    )
                except (json.JSONDecodeError, OSError):
                    manifest = {}

            for m_path, m_entry in manifest.items():
                if m_entry.get("emb_file") == emb_filename:
                    if _normalize_path(m_path) in current_paths:
                        is_current = True
                    break

            if not is_current:
                emb_file.unlink(missing_ok=True)

        # Write new emb_ files and update manifest
        result_vectors: dict[str, dict[str, Any]] = {}

        for path, vec in new_vectors.items():
            emb_file = _path_to_emb_filename(path)
            self._write_emb_file(path, vec)
            self._write_manifest_entry(
                path=path,
                name=vec.get("name", ""),
                category=vec.get("category"),
                embed_input=vec.get("embed_input", ""),
                emb_file=emb_file,
            )
            # Store vector data for return (including metadata fields caller expects)
            result_vectors[_normalize_path(path)] = vec

        # Also include any existing emb_ files that weren't in new_vectors
        for doc in docs:
            norm_path = _normalize_path(doc.path)
            if norm_path not in result_vectors:
                emb_file = _path_to_emb_filename(doc.path)
                emb_path = self.cache_dir / emb_file
                if emb_path.exists():
                    try:
                        emb_data = json.loads(
                            emb_path.read_text(encoding="utf-8")
                        )
                        if emb_data.get("mtime") == doc.mtime:
                            result_vectors[norm_path] = emb_data
                    except (json.JSONDecodeError, OSError):
                        pass

        return result_vectors

    def _delete_all_emb_files(self) -> None:
        """Delete all emb_*.json files and manifest.json (dimension mismatch → full rebuild)."""
        for emb_file in self.cache_dir.glob("emb_*.json"):
            emb_file.unlink(missing_ok=True)
        self.manifest_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# SkillSearcher — Orchestrator
# ---------------------------------------------------------------------------

class SkillSearcher:
    """Orchestrator: collect Skills, select engine, execute search."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = CACHE_MODEL,
        dimension: int = CACHE_DIMENSION,
        weights: dict[str, float] | None = None,
        cache_dir: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.dimension = dimension
        self.weights = weights or HYBRID_WEIGHTS
        self.cache_dir = cache_dir

        self.collector = SkillCollector()
        self.cache_manager = CacheManager(cache_dir=cache_dir)

    def search(
        self,
        query: str,
        dirs: list[str] | None = None,
        top_k: int = 5,
    ) -> dict[str, Any]:
        """Execute search with automatic engine selection.

        Returns JSON-serializable dict:
        {"engine", "results", "warnings", "query", "total_skills"}
        """
        docs, warnings = self.collector.collect(dirs)

        if not docs:
            return {
                "engine": "none",
                "results": [],
                "warnings": warnings,
                "query": query,
                "total_skills": 0,
            }

        # Engine selection: try embedding first, fallback to BM25 if cache empty
        engine = "bm25-three-layer"
        results = []

        if self.api_key:
            embedding_engine = EmbeddingEngine(
                api_key=self.api_key,
                model=self.model,
                dimension=self.dimension,
                weights=self.weights,
            )
            results = self._embedding_search(
                embedding_engine, query, docs, top_k, warnings,
            )

            # Fallback to BM25 when embedding cache coverage is too low
            if not results:
                warnings.append(
                    "Embedding cache empty — falling back to BM25 "
                    "(run build-cache or build_cache_entry.py to populate cache)"
                )
                engine = "bm25-three-layer"
                bm25_engine = BM25Engine()
                results = bm25_engine.search(query, docs, top_k=top_k)
            else:
                engine = "hybrid-embedding"

        if engine == "bm25-three-layer" and not results:
            bm25_engine = BM25Engine()
            results = bm25_engine.search(query, docs, top_k=top_k)

        return {
            "engine": engine,
            "results": [
                {"name": r.name, "path": r.path, "score": r.score, "rank": r.rank, "relevance": r.relevance}
                for r in results
            ],
            "warnings": warnings,
            "query": query,
            "total_skills": len(docs),
        }

    def _embedding_search(
        self,
        engine: EmbeddingEngine,
        query: str,
        docs: list[SkillDocument],
        top_k: int,
        warnings: list[str],
    ) -> list[SearchResult]:
        """Execute embedding search with cache support.

        Only searches Skills with cached vectors. Uncached Skills are skipped
        — they should be processed by subAgent + build_cache_entry.py asynchronously.
        """
        # Get cached vectors (only Skills with matching mtime)
        cached = self.cache_manager.get_cached_vectors(docs)

        # Identify uncached Skills
        uncached_paths = [d.path for d in docs if d.path not in cached]
        if uncached_paths:
            warnings.append(
                f"{len(uncached_paths)} Skills pending cache update "
                f"(run build_cache_entry.py via subAgent)"
            )

        # Search only cached Skills
        return engine.search(query, docs, cached, top_k=top_k)