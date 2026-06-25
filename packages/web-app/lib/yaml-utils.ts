import yaml from "js-yaml"

const VALID_NODE_TYPES = new Set(["bash", "python", "agent", "condition", "approval", "loop", "swarm"])

export function parseYaml(content: string): Record<string, unknown> | null {
  try {
    return yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isWorkflowYaml(content: string): boolean {
  const parsed = parseYaml(content)
  if (!parsed || typeof parsed !== "object") return false
  const nodes = parsed["nodes"]
  if (!Array.isArray(nodes)) return false
  if (nodes.length === 0) return false
  return nodes.every(
    (node: unknown) =>
      typeof node === "object" &&
      node !== null &&
      "id" in node &&
      "type" in node &&
      VALID_NODE_TYPES.has((node as Record<string, unknown>).type as string)
  )
}

export function getLanguageFromExtension(extension?: string): string {
  const map: Record<string, string> = {
    tsx: "typescript",
    ts: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    py: "python",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    html: "html",
    css: "css",
    java: "java",
    xml: "xml",
    go: "go",
    sql: "sql",
    rs: "rust",
    rb: "ruby",
    php: "php",
    kt: "kotlin",
    kts: "kotlin",
    scala: "scala",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    h: "c",
    hpp: "cpp",
    toml: "toml",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    bat: "bat",
    cmd: "bat",
    dockerfile: "dockerfile",
    graphql: "graphql",
    gql: "graphql",
    dart: "dart",
    r: "r",
    properties: "properties",
    gradle: "groovy",
    groovy: "groovy",
    proto: "protobuf",
    make: "makefile",
    mk: "makefile",
    lua: "lua",
    perl: "perl",
    pl: "perl",
    pm: "perl",
    swift: "swift",
    vue: "html",
    svelte: "html",
    less: "css",
    scss: "css",
    sass: "css",
    svg: "xml",
    plist: "xml",
    resx: "xml",
    cs: "csharp",
    fs: "fsharp",
    d: "d",
    zig: "zig",
    wasm: "plaintext",
  }
  return extension ? map[extension.toLowerCase()] || "plaintext" : "plaintext"
}