/** 探针 2：确认 -wal 文件是否在小写入后立即存在、内存库的 name/memory 属性。 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dir = join(import.meta.dirname, '.probe2')
mkdirSync(dir, { recursive: true })

// A) 小写入后 -wal 是否立即存在（决定 open.test.ts 里那条断言稳不稳）
const p = join(dir, 'small.db')
const db = new Database(p)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = full')
console.log('A after open   : wal exists =', existsSync(p + '-wal'))
db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
console.log('A after create : wal exists =', existsSync(p + '-wal'), 'size =', existsSync(p + '-wal') ? statSync(p + '-wal').size : -1)
db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '正文')
console.log('A after insert : wal exists =', existsSync(p + '-wal'), 'size =', existsSync(p + '-wal') ? statSync(p + '-wal').size : -1)
console.log('A main size =', statSync(p).size)
db.close()
console.log('A after close  : wal exists =', existsSync(p + '-wal'))

// B) 关闭后 raw pragma 值
const ro = new Database(p, { readonly: true })
console.log('B ro journal =', ro.pragma('journal_mode', { simple: true }), 'synchronous =', ro.pragma('synchronous', { simple: true }), 'fk =', ro.pragma('foreign_keys', { simple: true }))
ro.close()

// C) 内存库的 name / memory / inTransaction
const m = new Database(':memory:')
console.log('C name =', JSON.stringify(m.name), 'memory =', m.memory, 'readonly =', m.readonly)
m.close()

// D) wal_autocheckpoint=0 后主文件单独复制是否丢数据（证明 VACUUM INTO 的必要性）
const q = join(dir, 'nockpt.db')
const w = new Database(q)
w.pragma('journal_mode = WAL')
w.pragma('synchronous = full')
w.pragma('wal_autocheckpoint = 0')
w.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
w.prepare('INSERT INTO t VALUES (?, ?)').run('a', '用户刚敲的正文')
const mainOnly = join(dir, 'mainonly.db')
copyFileSync(q, mainOnly)
console.log('D wal size =', existsSync(q + '-wal') ? statSync(q + '-wal').size : -1, 'main size =', statSync(q).size)
const lonely = new Database(mainOnly)
console.log('D naive copy tables =', JSON.stringify(lonely.prepare("select name from sqlite_master where type='table'").all()))
lonely.close()
const vac = join(dir, 'vac.db')
w.prepare('VACUUM INTO ?').run(vac)
const good = new Database(vac, { readonly: true })
console.log('D vacuum backup tables =', JSON.stringify(good.prepare("select name from sqlite_master where type='table'").all()),
  'rows =', JSON.stringify(good.prepare('select * from t').all()))
good.close()
w.close()

// E) VACUUM INTO 之后目标的 journal_mode 是什么？只读打开 t 表是否可读
const v2 = new Database(vac, { readonly: true })
console.log('E backup journal =', v2.pragma('journal_mode', { simple: true }), 'user_version =', v2.pragma('user_version', { simple: true }))
v2.close()

// F) 部分唯一索引 + AUTOINCREMENT 的 memory 库表集合
const mm = new Database(':memory:')
mm.exec("CREATE TABLE sm (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER, success INTEGER); CREATE UNIQUE INDEX uq ON sm(v) WHERE success = 1")
console.log('F tables =', JSON.stringify(mm.prepare("select name from sqlite_master where type='table'").all()),
  'idx =', JSON.stringify(mm.prepare("select name from sqlite_master where type='index' AND name NOT LIKE 'sqlite_%'").all()))
mm.close()

// G) PRAGMA table_info 的输出列
const g = new Database(':memory:')
g.exec("CREATE TABLE x (a TEXT PRIMARY KEY NOT NULL, b INTEGER NOT NULL DEFAULT 0, c TEXT)")
console.log('G table_info =', JSON.stringify(g.prepare('PRAGMA table_info(x)').all()))
g.close()
