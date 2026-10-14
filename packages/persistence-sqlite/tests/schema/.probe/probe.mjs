/** 临时探针：确认 better-sqlite3 的实际行为，不留在交付物里。 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dir = join(import.meta.dirname, '.probe')
mkdirSync(dir, { recursive: true })
const path = join(dir, 'probe.db')

const db = new Database(path)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = full')
console.log('sqlite', db.prepare('select sqlite_version() as v').get())

// 1) VACUUM INTO 带参数绑定是否可用
db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '正文')
const bak = join(dir, 'bak.db')
try {
  db.prepare('VACUUM INTO ?').run(bak)
  console.log('VACUUM INTO ? ->', existsSync(bak), statSync(bak).size)
} catch (e) {
  console.log('VACUUM INTO ? FAILED:', e.constructor.name, e.message)
}
// 1b) 目标已存在时
try {
  db.prepare('VACUUM INTO ?').run(bak)
  console.log('VACUUM INTO existing -> OK (会覆盖?)')
} catch (e) {
  console.log('VACUUM INTO existing -> throws:', e.code, e.message)
}

// 2) 事务内 VACUUM
try {
  db.exec('BEGIN')
  db.prepare('VACUUM INTO ?').run(join(dir, 'bak2.db'))
  db.exec('ROLLBACK')
  console.log('VACUUM in txn -> OK')
} catch (e) {
  try { db.exec('ROLLBACK') } catch {}
  console.log('VACUUM in txn -> throws:', e.code, e.message)
}

// 3) 事务内 PRAGMA journal_mode
try {
  db.exec('BEGIN')
  db.pragma('journal_mode = delete')
  db.exec('ROLLBACK')
  console.log('PRAGMA journal_mode in txn -> OK')
} catch (e) {
  try { db.exec('ROLLBACK') } catch {}
  console.log('PRAGMA journal_mode in txn -> throws:', e.code, e.message)
}

// 4) 只读连接上写入的错误形态
const ro = new Database(path, { readonly: true })
try {
  ro.exec('CREATE TABLE nope (id TEXT)')
} catch (e) {
  console.log('readonly exec ->', e.constructor.name, 'code=', e.code, 'msg=', e.message)
}
try {
  ro.prepare('INSERT INTO t VALUES (?, ?)').run('x', 'y')
} catch (e) {
  console.log('readonly insert ->', e.constructor.name, 'code=', e.code, 'msg=', e.message)
}
console.log('ro pragma foreign_keys =', ro.pragma('foreign_keys', { simple: true }))

// 5) 主文件单独复制（不复制 WAL）会丢数据吗
const walSize = existsSync(path + '-wal') ? statSync(path + '-wal').size : -1
console.log('wal size before copy =', walSize)
const lonely = join(dir, 'lonely.db')
try {
  copyFileSync(path, lonely)
  const copy = new Database(lonely)
  const tables = copy.prepare("select name from sqlite_master where type='table'").all()
  const rows = tables.some((t) => t.name === 't')
    ? copy.prepare('select count(*) c from t').get()
    : 'table t missing'
  console.log('copy of main file only ->', JSON.stringify(tables), rows)
  copy.close()
} catch (e) {
  console.log('copyFileSync/main-only open FAILED:', e.code, e.message)
}
ro.close()
db.close()

// 6) 关闭连接后 WAL 是否被检查点并回
console.log('wal size after close =', existsSync(path + '-wal') ? statSync(path + '-wal').size : 'no wal file')

// 7) 只读打开一个不存在且 fileMustExist 的库
try {
  new Database(join(dir, 'missing.db'), { readonly: true, fileMustExist: true })
} catch (e) {
  console.log('fileMustExist missing ->', e.code, e.message, 'created=', existsSync(join(dir, 'missing.db')))
}

// 8) 打开不存在文件的只读（不带 fileMustExist）
try {
  const x = new Database(join(dir, 'ghost.db'), { readonly: true })
  x.exec('CREATE TABLE t (id TEXT)')
} catch (e) {
  console.log('readonly create-only ->', e.code, e.message)
}

// 9) 部分唯一索引 + AUTOINCREMENT 的 sqlite_sequence 表
const m = new Database(':memory:')
m.exec("CREATE TABLE sm (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER, success INTEGER); CREATE UNIQUE INDEX uq ON sm(v) WHERE success = 1")
console.log('memory tables =', JSON.stringify(m.prepare("select name from sqlite_master where type='table'").all()))
console.log('memory sync =', m.pragma('synchronous', { simple: true }), 'jrnl =', m.pragma('journal_mode', { simple: true }))
m.close()
