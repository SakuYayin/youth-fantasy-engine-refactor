#!/usr/bin/env node
/**
 * 测试串行锁。
 *
 * 用户硬性纪律（m00001）：**禁止同时运行一个测试**。全量测试会写同一个
 * vitest 缓存目录并争抢 CPU，两个成员同时跑会互相污染且让性能数据失去意义。
 *
 * 用法：
 *   node tools/test-lock.mjs acquire <成员名> [说明]
 *   node tools/test-lock.mjs release <成员名>
 *   node tools/test-lock.mjs status
 *
 * 退出码：0 成功；1 缺参数；2 锁已被他人持有。
 *
 * 实现刻意用「文件 + 独占创建标志」而不是内存状态：多个进程、多个终端、
 * 不同成员都可能同时调用，只有 O_EXCL 能在所有平台上原子地表达"我抢到了"。
 * 锁文件带 PID 与时间戳，便于判断持有者是否已经死掉（超过 STALE_MS 可接管）。
 */

import { open, readFile, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCK_PATH = join(HERE, '..', '.test-lock')

/** 锁超过这个时长视为持有者已崩溃，允许接管。20 分钟够跑完全量测试。 */
const STALE_MS = 20 * 60 * 1000

async function readLock() {
  try {
    const raw = await readFile(LOCK_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function isStale(lock) {
  if (!lock?.acquiredAt) return true
  const age = Date.now() - Date.parse(lock.acquiredAt)
  return !Number.isFinite(age) || age > STALE_MS
}

async function acquire(owner, note) {
  if (!owner) {
    console.error('错误：acquire 需要成员名。用法：node tools/test-lock.mjs acquire <成员名>')
    process.exit(1)
  }

  const existing = await readLock()
  if (existing && existing.owner !== owner && !(await isStale(existing))) {
    console.error(
      `测试锁已被占用：owner=${existing.owner} 于 ${existing.acquiredAt} 获取` +
        (existing.note ? `（${existing.note}）` : ''),
    )
    console.error(`若确认持有者已退出，删除 ${LOCK_PATH} 后重试。`)
    process.exit(2)
  }

  const payload = JSON.stringify(
    { owner, note: note ?? '', pid: process.pid, acquiredAt: new Date().toISOString() },
    null,
    2,
  )

  // wx = O_CREAT|O_EXCL：文件已存在即失败，这是跨进程原子的。
  let handle
  try {
    handle = await open(LOCK_PATH, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // 竞争窗口：检查是否是我自己或已过期，是则覆盖。
      const current = await readLock()
      if (current && current.owner !== owner && !(await isStale(current))) {
        console.error(`测试锁被 ${current.owner} 抢占，本次未获取。`)
        process.exit(2)
      }
      await unlink(LOCK_PATH).catch(() => {})
      handle = await open(LOCK_PATH, 'wx')
    } else {
      throw error
    }
  }

  await handle.writeFile(payload, 'utf8')
  await handle.close()
  console.log(`测试锁已获取：owner=${owner}${note ? ` note=${note}` : ''}`)
  console.log('用完请执行：node tools/test-lock.mjs release ' + owner)
}

async function release(owner) {
  const existing = await readLock()
  if (!existing) {
    console.log('没有测试锁需要释放。')
    return
  }
  if (owner && existing.owner !== owner) {
    console.error(`拒绝释放：锁由 ${existing.owner} 持有，调用者是 ${owner}。`)
    process.exit(2)
  }
  await unlink(LOCK_PATH)
  console.log(`测试锁已释放（原持有者 ${existing.owner}）。`)
}

async function status() {
  const existing = await readLock()
  if (!existing) {
    console.log('测试锁空闲。')
    return
  }
  let alive = '未知'
  try {
    await stat(`/proc/${existing.pid}`)
    alive = '进程存在'
  } catch {
    alive = '进程可能已退出'
  }
  const stale = await isStale(existing)
  console.log(
    `测试锁：owner=${existing.owner} pid=${existing.pid} 获取于 ${existing.acquiredAt}` +
      `（${alive}${stale ? '，已超过过期阈值' : ''}）`,
  )
}

const [action, owner, note] = process.argv.slice(2)
switch (action) {
  case 'acquire':
    await acquire(owner, note)
    break
  case 'release':
    await release(owner)
    break
  case 'status':
    await status()
    break
  default:
    console.error('用法：node tools/test-lock.mjs <acquire|release|status> [成员名] [说明]')
    process.exit(1)
}
