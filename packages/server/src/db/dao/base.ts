import type Database from "better-sqlite3"

/**
 * BaseDAO — abstract base class for all DAOs.
 * Provides prepared statement caching, transaction helpers, and pagination.
 */
export abstract class BaseDAO {
  private stmtCache = new Map<string, Database.Statement>()

  constructor(protected readonly db: Database.Database) {}

  /**
   * Get or prepare a cached SQL statement.
   */
  protected stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  /**
   * Execute a function inside a database transaction.
   */
  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * Unified pagination helper.
   * Returns { data, total, page, pageSize }.
   */
  protected paginate<T>(
    dataSql: string,
    countSql: string,
    params: unknown[],
    page: number,
    pageSize: number,
  ): { data: T[]; total: number; page: number; pageSize: number } {
    const safePage = Math.max(1, page)
    const safePageSize = Math.min(100, Math.max(1, pageSize))
    const offset = (safePage - 1) * safePageSize

    const total = (this.stmt(countSql).get(...params) as { cnt: number }).cnt
    const data = this.stmt(dataSql).all(...params, safePageSize, offset) as T[]

    return { data, total, page: safePage, pageSize: safePageSize }
  }
}
