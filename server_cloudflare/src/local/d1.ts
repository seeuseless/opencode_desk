/**
 * D1 → node:sqlite 适配层：把业务代码用到的 D1 API 形状
 * （prepare / bind / first / all / run / batch）映射到 Node 内置 SQLite。
 * 业务 SQL 全部用 `?` 顺序占位符，与 node:sqlite 一致；batch 按事务顺序执行（D1 同款语义）。
 */

/** node:sqlite 的 DatabaseSync 结构化最小面（避免引入 @types/node 之外的全局类型冲突）。 */
interface SQLDB {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): void
}

type RunResult = { meta: { last_row_id: number; changes: number } }

/** D1PreparedStatement 的本地等价：bind 返回携带参数的新语句（不可变，与 D1 一致）。 */
// 字段显式赋值而不是构造器参数属性——node 直接跑 TS 是 strip-only，不支持参数属性语法
class Stmt {
  private db: SQLDB
  private sql: string
  private vals: unknown[]

  constructor(db: SQLDB, sql: string, vals: unknown[]) {
    this.db = db
    this.sql = sql
    this.vals = vals
  }

  bind(...vals: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, vals)
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.vals) as T) ?? null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.vals) as T[] }
  }

  async run(): Promise<RunResult> {
    const r = this.db.prepare(this.sql).run(...this.vals)
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }
  }
}

/** D1Database 的本地等价。 */
export class LocalD1 {
  private db: SQLDB

  constructor(db: SQLDB) {
    this.db = db
  }

  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql, [])
  }

  async batch(stmts: Stmt[]): Promise<RunResult[]> {
    this.db.exec('BEGIN')
    try {
      const out: RunResult[] = []
      for (const s of stmts) out.push(await s.run())
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
