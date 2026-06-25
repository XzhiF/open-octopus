"""octopus-mcp-cli — CLI tool for direct MCP backend server calls.

Usage:
    octopus-mcp-cli <server_name> <tool_name> [params_json] [--env prod] [--org xzf]

Reads ~/.octopus/{org}/mcp/mcp_{env}.yaml to find server connection config,
then calls the backend MCP server directly using MCP protocol.
"""

import argparse
import json
import sys
from pathlib import Path


def load_mcp_registry(env: str, org: str = "") -> dict:
    """Load MCP YAML registry for the specified environment and org.

    File naming convention: mcp_{env}.yaml (e.g. mcp_prod.yaml, mcp_uat01.yaml).
    Dynamic discovery — no hardcoded env list.
    """
    yaml_name = f"mcp_{env}.yaml"

    # Determine org directory
    if org:
        registry_path = Path.home() / ".octopus" / org / "mcp" / yaml_name
    else:
        # Fallback: try default_org from global config
        global_config_path = Path.home() / ".octopus" / "config.yaml"
        if global_config_path.is_file():
            with open(global_config_path, encoding="utf-8") as f:
                for line in f:
                    stripped = line.strip()
                    if stripped.startswith("default_org:"):
                        org = stripped.split(":", 1)[1].strip()
                        break
        if org:
            registry_path = Path.home() / ".octopus" / org / "mcp" / yaml_name
        else:
            # Fallback: use flat path (only if org setup hasn't been run)
            # This path won't exist in v5 org-scoped deployments
            registry_path = Path.home() / ".octopus" / yaml_name

    if not registry_path.exists():
        print(f"Error: MCP registry not found: {registry_path}", file=sys.stderr)
        print("Hint: Run 'octopus setup' to generate registry skeleton", file=sys.stderr)
        sys.exit(1)

    try:
        import yaml
        data = yaml.safe_load(registry_path.read_text(encoding="utf-8"))
    except ImportError:
        print("Error: PyYAML not installed. Run: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: Failed to load {registry_path}: {e}", file=sys.stderr)
        sys.exit(1)

    return data


def find_server(registry: dict, server_name: str) -> dict | None:
    """Find a server entry by name in the registry."""
    servers = registry.get("mcp_servers", [])
    for server in servers:
        if server.get("name") == server_name:
            return server
    return None


def call_mcp_server(connect_config: dict, tool_name: str, params: dict) -> dict:
    """Call a backend MCP server directly using MCP protocol."""
    conn_type = connect_config.get("type", "streamable-http")
    url = connect_config.get("url", "")

    if not url:
        return {"error": "No URL in connection config"}

    if conn_type == "streamable-http":
        return _call_streamable_http(url, tool_name, params)
    elif conn_type == "sse":
        return _call_sse(url, tool_name, params)
    else:
        return {"error": f"Unsupported connection type: {conn_type}"}


def _call_streamable_http(url: str, tool_name: str, params: dict) -> dict:
    """Call MCP server via streamable-http protocol using urllib."""
    import urllib.request
    import urllib.error

    endpoint = url.rstrip("/") + "/tools/call"
    payload = json.dumps({
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": params,
        },
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}
    except TimeoutError:
        return {"error": "Request timed out (30s)"}

    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        return {"error": f"Invalid JSON response: {e}"}
    except Exception as e:
        return {"error": f"Unexpected: {e}"}


def _call_sse(url: str, tool_name: str, params: dict) -> dict:
    """Call MCP server via SSE protocol (placeholder — needs mcp SDK)."""
    try:
        from mcp.client.sse import sse_client
        from mcp.client.session import ClientSession
    except ImportError:
        return {"error": "MCP SDK not installed. Run: pip install mcp"}

    return {"error": "SSE protocol not yet implemented in octopus-mcp-cli. Use streamable-http."}


def main():
    parser = argparse.ArgumentParser(
        description="octopus-mcp-cli — Direct MCP backend server calls via YAML registry",
    )
    parser.add_argument("server_name", help="MCP server name (from YAML registry)")
    parser.add_argument("tool_name", help="Tool name to call on the MCP server")
    parser.add_argument(
        "params",
        nargs="?",
        default="{}",
        help="JSON params for the tool call (default: {})",
    )
    parser.add_argument(
        "--env",
        default="prod",
        help="MCP registry environment (default: prod, any env name matching mcp_{env}.yaml)",
    )
    parser.add_argument(
        "--org",
        default="",
        help="Org name (from ~/.octopus/config.yaml default_org if not specified)",
    )

    args = parser.parse_args()

    try:
        params = json.loads(args.params)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON params: {e}", file=sys.stderr)
        sys.exit(1)

    registry = load_mcp_registry(args.env, args.org)
    server = find_server(registry, args.server_name)

    if not server:
        available = [s.get("name", "?") for s in registry.get("mcp_servers", [])]
        print(f"Error: Server '{args.server_name}' not found in registry", file=sys.stderr)
        if available:
            print(f"Available servers: {', '.join(available)}", file=sys.stderr)
        else:
            print("Registry is empty (skeleton). Add server entries manually.", file=sys.stderr)
        sys.exit(1)

    connect_config = server.get("connect", {})
    if not connect_config:
        print(f"Error: Server '{args.server_name}' has no connect config", file=sys.stderr)
        sys.exit(1)

    result = call_mcp_server(connect_config, args.tool_name, params)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()