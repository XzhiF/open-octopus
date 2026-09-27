// packages/server/src/db/dao/pg-mappers.ts
//
// P1 B1 — PG 行值 → 旧 SQLite 行契约的归一化小工具。
//
// 背景（db/pg/README.md「布尔翻面」+ schema-parity 四张映射表）：
// postgres.js 对 PG 原生类型给出的 JS 值与 better-sqlite3 不同 ——
//   timestamptz → Date、jsonb → 解析后的 object、int8/bigint（含 COUNT）→ string、
//   boolean → true/false。
// B1 的五个 DAO 选择**在 DAO 出口归一回旧契约**（ISO 串 / JSON 串 / number / 0-1），
// 让 18 个调用面文件与 route 快照零语义漂移；旧 SQLite DAO 与共享 Row 接口
// （types.ts）保持原形状直到 B6 收口。B3-B5 各批如走同一路径，此文件是共同落点。

/** timestamptz(Date) 或已是 ISO 串 → ISO 串；null/undefined 透传 null。 */
export function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString() : v
}

export function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

/** jsonb(解析后 object / 原样文本) → JSON 串；null/undefined → null。 */
export function jsonStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string") return v
  return JSON.stringify(v)
}

/** int8/COUNT 的 string 表示 → JS number。 */
export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === "number" ? v : Number(v)
}

/** boolean(true/false) 或旧 0/1 → 旧契约的 0/1。 */
export function flag(v: boolean | number | null | undefined): number {
  if (typeof v === "boolean") return v ? 1 : 0
  return v ?? 0
}

/** 旧契约的 0/1（或 boolean 直传）→ PG boolean 列参数。 */
export function bool(v: number | boolean | undefined): boolean {
  return v === undefined ? true : (typeof v === "boolean" ? v : v !== 0)
}
