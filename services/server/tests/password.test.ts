/**
 * 密码摘要：正确/错误口令、加盐、常数时间比较。
 *
 * 这里刻意**不做**"哈希值等于某个固定串"的断言——摘要串里含随机盐，
 * 那类断言只能靠重算，等于把实现抄进测试。断言的是**性质**：
 * 正确口令通过、错误口令不通过、同口令两次摘要不同、畸形摘要不抛异常。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_ALGORITHM,
  SALT_BYTES,
  burnPasswordCheck,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  rehashPassword,
  verifyPassword,
} from '../src/auth/password.js'

describe('hashPassword / verifyPassword', () => {
  it('正确口令通过、错误口令（含仅差一个字符）不通过', async () => {
    const stored = await hashPassword('correct-horse-battery')
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true)
    expect(await verifyPassword('correct-horse-batterz', stored)).toBe(false)
    expect(await verifyPassword('CORRECT-HORSE-BATTERY', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('同一口令两次 hash 结果不同（每次独立随机盐），但都能校验通过', async () => {
    const first = await hashPassword('same-password-twice')
    const second = await hashPassword('same-password-twice')
    expect(first).not.toBe(second)

    const parsedFirst = parsePasswordHash(first)
    const parsedSecond = parsePasswordHash(second)
    expect(parsedFirst).not.toBeNull()
    expect(parsedSecond).not.toBeNull()
    // 盐必须不同（这才是"两次摘要不同"的根因，而不是编码差异）。
    expect(parsedFirst?.salt.equals(parsedSecond?.salt ?? Buffer.alloc(0))).toBe(false)
    expect(parsedFirst?.salt.length).toBe(SALT_BYTES)

    expect(await verifyPassword('same-password-twice', first)).toBe(true)
    expect(await verifyPassword('same-password-twice', second)).toBe(true)
    // 交叉验证：一份摘要的盐不能验出另一份的口令以外的任何东西。
    expect(await verifyPassword('other-password-twice', first)).toBe(false)
  })

  it('摘要串是自描述的 scrypt 串，参数可解析回原值', async () => {
    const stored = await hashPassword('describe-me', { N: 2 ** 14, r: 8, p: 1 })
    expect(stored.startsWith(`${PASSWORD_ALGORITHM}$`)).toBe(true)
    const parsed = parsePasswordHash(stored)
    expect(parsed?.algorithm).toBe(PASSWORD_ALGORITHM)
    expect(parsed?.params).toEqual({ N: 2 ** 14, r: 8, p: 1 })
    expect(parsed?.digest.length).toBe(32)
  })

  it('空口令直接拒绝（不产生可用摘要）', async () => {
    await expect(hashPassword('')).rejects.toThrow(TypeError)
  })
})

describe('parsePasswordHash 畸形输入', () => {
  it('各种畸形串一律返回 null，绝不抛异常', () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$N=32768,r=8,p=1$onlythree',
      'bcrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA',
      // N 不是 2 的幂：scrypt 会在 KDF 里抛错，必须在解析阶段就挡掉。
      'scrypt$N=3,r=8,p=1$c2FsdA$aGFzaA',
      // 参数缺失
      'scrypt$N=32768,r=8$c2FsdA$aGFzaA',
      // 未知参数名
      'scrypt$N=32768,r=8,p=1,x=2$c2FsdA$aGFzaA',
      // 盐长度不对（base64url 解出来不是 16 字节）
      'scrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA',
    ]
    for (const stored of malformed) {
      expect(parsePasswordHash(stored)).toBeNull()
    }
  })

  it('畸形摘要串上的 verifyPassword 返回 false，且不把内部错误抛出来', async () => {
    expect(await verifyPassword('anything', 'scrypt$N=3,r=8,p=1$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
  })
})

describe('校验路径不做长度短路', () => {
  it('超短错误口令仍然跑完整 KDF（不会因长度不符提前返回）', async () => {
    const stored = await hashPassword('a-sufficiently-long-password')
    const fullLengthWrong = 'b'.repeat(26)

    const shortStart = performance.now()
    const shortResult = await verifyPassword('b', stored)
    const shortMs = performance.now() - shortStart

    const longStart = performance.now()
    const longResult = await verifyPassword(fullLengthWrong, stored)
    const longMs = performance.now() - longStart

    expect(shortResult).toBe(false)
    expect(longResult).toBe(false)

    // 🔴 要点：长度 1 的错误口令**不能**比长度相同的错误口令快一个数量级。
    // 若实现里存在 `if (candidate.length !== digest.length) return false` 这种
    // 提前返回，`shortMs` 会掉到亚毫秒级。阈值给得很宽松（5ms）以免受 CI 抖动影响，
    // 但足以把"完全跳过 KDF"的实现钉死。
    expect(shortMs).toBeGreaterThan(5)
    expect(longMs).toBeGreaterThan(5)
    expect(shortMs).toBeGreaterThan(longMs * 0.2)
  })

  it('用户名不存在时的 burnPasswordCheck 也消耗真实 KDF 时间', async () => {
    const start = performance.now()
    await burnPasswordCheck('whatever-the-attacker-tried')
    const elapsed = performance.now() - start
    expect(elapsed).toBeGreaterThan(5)
  })
})

describe('参数升级', () => {
  it('旧参数的摘要判定为需要重算，重算后可校验', async () => {
    const weak = await hashPassword('upgrade-me-please', { N: 2 ** 13, r: 8, p: 1 })
    expect(needsRehash(weak, DEFAULT_SCRYPT_PARAMS)).toBe(true)
    expect(needsRehash(weak, { N: 2 ** 13, r: 8, p: 1 })).toBe(false)

    const upgraded = await rehashPassword('upgrade-me-please')
    expect(needsRehash(upgraded, DEFAULT_SCRYPT_PARAMS)).toBe(false)
    expect(await verifyPassword('upgrade-me-please', upgraded)).toBe(true)
    expect(await verifyPassword('upgrade-me-please', weak)).toBe(true)
  })
})
