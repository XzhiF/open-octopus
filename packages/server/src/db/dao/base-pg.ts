/**
 * BasePgDAO — postgres.js 异步 DAO 基类（P1 交付物 2 · p1-batch-plan.md §7）。
 *
 * 与旧 BaseDAO（base.ts，活到 B5 结束）的关系是**并行类**，不是改造：
 * B1-B5 每批迁移一个 DAO 时 `extends BaseDAO` → `extends BasePgDAO`，
 * 混迁期两基类共存。§8 的 await-thenable / no-misused-promises 规则
 * 就是为这个双引擎窗口兜底的。
 *
 * 机械改写映射（§7 模式规则）：
 *   stmt().all(...)  →  await this.q(...)
 *   stmt().get(...)  →  await this.q1(...)      // undefined 而非 null，调用方 ?? null 补齐
 *   stmt().run(...)  →  await this.exec(...)    // { changes }；需要 id 的语句自带 RETURNING
 *   transaction(fn)  →  await this.transaction(fn)
 *   paginate(...)    →  await this.paginate(...)
 */
import type { Sql, TransactionSql } from "postgres"
import type { PaginatedResult } from "../types"

/** 池句柄或事务句柄 —— 子类构造时从注册表拿到的就是这个联合。 */
export type PgSql = Sql | TransactionSql

/**
 * `?` → `$n` 位置替换。
 *
 * 两条铁律（都有对拍测试钉住，见 __tests__/base-pg.test.ts）：
 *  1. **编号必须来自独立计数器**。§7 草案的 `replace(/\?/g, (_, i) => `$${++i}`)`
 *     里第二个回调参数是**匹配位置偏移**不是序号 —— "a ? b ?" 会产出 "$3 $9"。
 *     本实现用闭包计数器。
 *  2. **SQL 单引号字符串字面量内的 `?` 不是占位符**（`'what?'`、`'?'` 比较值、
 *     文本提示词）。全仓 540 处静态 stmt SQL 实测零命中字符串内 `?`（§7 口径
 *     成立 —— 证伪测试逐文件扫描兜底），但 B1 起会新增含文案的 INSERT，
 *     这里直接做成引号感知替换：把风险类别关掉，而不是祈祷扫描永远干净。
 *     `''` 按 SQL 规范视为引号内转义的单引号，不翻出引号状态。
 */
export function convertPlaceholders(sql: string): string {
  let out = ""
  let n = 0
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "''"; i++; continue } // 字符串内转义引号
        inString = false
      }
      out += ch
      continue
    }
    if (ch === "'") { inString = true; out += ch; continue }
    if (ch === "?") { out += `$${++n}`; continue }
    out += ch
  }
  return out
}

export abstract class BasePgDAO {
  constructor(protected readonly db: PgSql) {}

  /** 当前句柄（池或事务）—— 仅注册表/调试用，子类业务方法不应绕过 q/exec。 */
  protected sql(): Sql {
    return this.db as Sql
  }

  /** 对应旧 stmt().all()。返回行数组（PG 列名保持小写原样，与 SQLite 一致）。 */
  protected async q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await this.sql().unsafe(convertPlaceholders(sql), params as never) as unknown as T[]
  }

  /** 对应旧 stmt().get() —— 无行返回 undefined（旧版是 undefined，别用 ?? null 之外的兜底）。 */
  protected async q1<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.q<T>(sql, params)
    return rows[0]
  }

  /**
   * 对应旧 stmt().run()。S2 清单里的 lastInsertRowid 不再由基类提供 ——
   * PG 姿势是写语句自带 `RETURNING id`，走 q1() 取；exec 只回 changes。
   */
  protected async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const r = await this.sql().unsafe(convertPlaceholders(sql), params as never)
    return { changes: (r as { count?: number }).count ?? 0 }
  }

  /**
   * 对应旧 db.transaction(fn)()。语义差异清单（§6）：
   *   - better-sqlite3 同步/deferred/可嵌套(savepoint)；postgres.js 是
   *     BEGIN/COMMIT + 专用连接 + RC 隔离级，**中途一条语句失败整个事务
   *     abort（25P02），体内 try/catch 吞错续跑的写法必须改 savepoint**。
   *   - 已在事务句柄上构造的 DAO（db = TransactionSql）再调 transaction()
   *     直接复用当前事务（savepoint 语义由调用方负责，与 §7 草案一致）。
   *   - **B 批改写红线**：better-sqlite3 的 transaction 体里 `this.stmt()` 天然
   *     走同一连接；PG 下事务只在 `fn(tx)` 给的句柄上生效 —— 体内若继续调
   *     只吃 `this.db`（池根句柄）的方法，写入会**逃逸出事务**且照常提交。
   *     迁移时体内一律经 tx 构造兄弟 DAO（`new XxxDAO(tx)`）或把 tx 作为显式
   *     参数下传；对拍测试钉住了这一行为差异（base-pg.test.ts「反模式钉桩」）。
   *   - 事务计数缺口（保持 B0 现状，不动 pool.ts）：pool.ts 的查询计数
   *     Proxy 只包根句柄，`sql.begin` 内派生的 TransactionSql 发出的语句
   *     暂不计数 —— inflight/queued 指标在事务密集期偏低，B6 收口再谈。
   */
  async transaction<T>(fn: (tx: PgSql) => Promise<T>): Promise<T> {
    const tx = this.db as Partial<TransactionSql>
    if (typeof tx.savepoint === "function") return fn(this.db) // 已在事务内
    return (this.db as Sql).begin(fn as (t: TransactionSql) => Promise<T>) as unknown as Promise<T>
  }

  /**
   * 统一分页 —— 与 base.ts 版逐参数对齐（旧语义实测钉在对拍测试里）：
   *   page 下限 1（非整数不夹紧，行为同旧）；pageSize 夹紧 [1,100]；
   *   dataSql 以 `... params + [pageSize, offset]` 执行（LIMIT ? OFFSET ? 结尾约定）；
   *   count 取 `.cnt` 字段。两次 await（S11）；PG 的 COUNT 是 bigint，
   *   Number() 归一化后与 SQLite 的 JS number 对拍等价。
   */
  protected async paginate<T>(
    dataSql: string,
    countSql: string,
    params: unknown[],
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<T>> {
    const safePage = Math.max(1, page)
    const safePageSize = Math.min(100, Math.max(1, pageSize))
    const offset = (safePage - 1) * safePageSize

    const countRow = await this.q1<{ cnt: number | string | bigint }>(countSql, params)
    const data = await this.q<T>(dataSql, [...params, safePageSize, offset])

    return { data, total: Number(countRow?.cnt ?? 0), page: safePage, pageSize: safePageSize }
  }
}
