#!/usr/bin/env python3
"""
GitLab Repo Index Generator — v2 (thin wrapper)

Delegates to octopus.repo_ops for all core operations.
Can still be run standalone via argparse CLI.

Modes:
  --full          Three-source synthesis (manifest + GitLab + local)
  --projects      Incremental update for specified projects only
  --sync-gitlab   Only update descriptions from GitLab API; validate manifest entries

Config:
  ~/.octopus/config.yaml   → clone_base, gitlab_url, groups
  GITLAB_TOKEN env var             → required for GitLab API calls
  ~/.octopus/repos/manifest.md → project list + manual tags
"""

import argparse
import os
import sys
from pathlib import Path

# Import from package — try direct import first, fallback to path insertion
try:
    from octopus.repo_ops import (
        DEFAULT_CONFIG_PATH,
        DEFAULT_MANIFEST_PATH,
        DEFAULT_OUTPUT_PATH,
        resolve_repos_config,
        run_full_mode,
        run_projects_mode,
        run_sync_gitlab_mode,
    )
except ImportError:
    # Running standalone from source — add project root to path
    _repo_root = Path(__file__).parent.parent.parent.parent.parent
    sys.path.insert(0, str(_repo_root / "src"))
    from octopus.repo_ops import (
        DEFAULT_CONFIG_PATH,
        DEFAULT_MANIFEST_PATH,
        DEFAULT_OUTPUT_PATH,
        resolve_repos_config,
        run_full_mode,
        run_projects_mode,
        run_sync_gitlab_mode,
    )

from rich.console import Console

console = Console()


def main():
    parser = argparse.ArgumentParser(
        description="GitLab Repo Index Generator v2 — manifest + GitLab + local scan",
    )

    # Mode selection
    parser.add_argument(
        "--full", action="store_true",
        help="Full three-source synthesis (manifest + GitLab + local scan)",
    )
    parser.add_argument(
        "--projects", nargs="+", metavar="PROJECT",
        help="Incremental update for specified projects only",
    )
    parser.add_argument(
        "--sync-gitlab", action="store_true",
        help="Only sync descriptions from GitLab API; validate manifest entries",
    )

    # Paths
    parser.add_argument("--config", default="", help="Config.yaml path")
    parser.add_argument("--manifest", default="", help="Manifest.md path")
    parser.add_argument("--output", default="", help="Output index.md path")
    parser.add_argument("--clone-base", default="", help="Base directory for local clones")

    # Overrides
    parser.add_argument("--gitlab-url", default="", help="Override gitlab_url")
    parser.add_argument("--gitlab-token", default="", help="Override GITLAB_TOKEN (otherwise reads env var)")
    parser.add_argument("--groups", default="", help="Override groups (comma-separated)")

    args = parser.parse_args()

    # Determine mode
    mode_count = sum([args.full, args.sync_gitlab, bool(args.projects)])
    if mode_count == 0:
        args.full = True  # Default: full
    elif mode_count > 1:
        print("Error: specify exactly one mode (--full, --projects, or --sync-gitlab)", file=sys.stderr)
        sys.exit(1)

    # Resolve config
    config_path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH
    config = resolve_repos_config(
        config_path=config_path,
        gitlab_url_override=args.gitlab_url,
        groups_override=args.groups,
        clone_base_override=args.clone_base,
        manifest_override=args.manifest,
        output_override=args.output,
    )

    # GITLAB_TOKEN from env or CLI override
    gitlab_token = args.gitlab_token or os.environ.get("GITLAB_TOKEN", "")

    console.print(f"Config: gitlab_url={config.gitlab_url}, groups={config.groups}, clone_base={config.clone_base}")
    console.print(f"Manifest: {config.manifest_path}")
    console.print(f"Output: {config.output_path}")

    # Execute selected mode
    if args.full:
        run_full_mode(config, gitlab_token, console=console)
    elif args.projects:
        run_projects_mode(config, gitlab_token, args.projects, console=console)
    elif args.sync_gitlab:
        errors = run_sync_gitlab_mode(config, gitlab_token, console=console)
        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()