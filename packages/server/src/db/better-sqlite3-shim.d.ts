// packages/server/src/db/better-sqlite3-shim.d.ts
//
// [P1 B5 票5B] @types/better-sqlite3 不在依赖树（B6 将整体摘除 better-sqlite3）。
// SQLite 只读退路一版本周期内，生产侧仍有 `Database.Database | Database.Statement |
// Database.RunResult` 类型消费面 —— 提供最小结构声明消 TS7016（隐式 any 门禁债）。
// 刻意宽松（返回值 any / 参数 any）：本 shim 只服务迁移过渡期的旧 SQLite 读面，
// 不做运行库校验；B6 下线 SQLite 退路时连同本文件一起删除。
declare module "better-sqlite3" {
  interface SqliteRunResult {
    changes: number
    lastInsertRowid: number | bigint
  }
  interface SqliteStatement {
    run(...params: any[]): SqliteRunResult
    get(...params: any[]): any
    all(...params: any[]): any[]
    iterate(...params: any[]): IterableIterator<any>
    pluck(yes?: boolean): SqliteStatement
    bind(...params: any[]): SqliteStatement
  }
  interface SqliteDatabaseType {
    prepare(sql: string): SqliteStatement
    transaction<F extends (...args: any[]) => any>(fn: F): F & { deferred: F; immediate: F; exclusive: F }
    exec(sql: string): SqliteDatabaseType
    pragma(sql: string, options?: object): any
    function(name: string, fn: (...args: any[]) => any, options?: object): SqliteDatabaseType
    aggregate(name: string, options: object): SqliteDatabaseType
    loadExtension(path: string): SqliteDatabaseType
    backup(destination: string, options?: object): Promise<Record<string, any>>
    close(): void
    readonly open: boolean
    readonly inTransaction: boolean
    readonly name: string
  }
  interface SqliteDatabaseConstructor {
    new (filename: string, options?: object): SqliteDatabaseType
    (filename?: string, options?: object): SqliteDatabaseType
  }
  const Database: SqliteDatabaseConstructor
  namespace Database {
    type Database = SqliteDatabaseType
    type Statement = SqliteStatement
    type RunResult = SqliteRunResult
    type BackupMetadata = Record<string, any>
  }
  export = Database
}
