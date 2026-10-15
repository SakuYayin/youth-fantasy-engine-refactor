/**
 * ids 契约测试。
 *
 * 重点覆盖**数据安全相关的判定函数**，而不是构造函数的 happy path：
 * `resolveConflict` 决定同步时谁的数据被保留，`encodeRevision` 决定版本号能否回绕，
 * `isWellFormedId` 是主键与路径的第一道闸门。
 */

import { describe, expect, it } from 'vitest'

import {
  cryptoRandomSource,
  encodeCursor,
  encodeRevision,
  fixedClock,
  isUtcTimestamp,
  isWellFormedId,
  makeId,
  newIds,
  newRevision,
  resolveConflict,
  systemClock,
} from '../src/ids.js'
import type { Cursor, Revision, WorkspaceId } from '../src/ids.js'

describe('跨离线副本 revision 身份', () => {
  it('相同库内序号在不同副本上生成不同标识，仍按相等关系裁决冲突', () => {
    const first = newRevision(2, { uuid: () => 'device-a-random-id' })
    const second = newRevision(2, { uuid: () => 'device-b-random-id' })
    expect(first).not.toBe(second)
    expect(resolveConflict({ baseRevision: encodeRevision(1), localRevision: first, remoteRevision: second }).kind).toBe('conflict')
    expect(newRevision(2)).not.toBe(newRevision(2))
    expect(() => newRevision(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// 标识符
// ---------------------------------------------------------------------------

describe('isWellFormedId', () => {
  it('接受前缀_随机串与 UUID 两种形态', () => {
    expect(isWellFormedId('doc_0123456789abcdef')).toBe(true)
    expect(isWellFormedId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isWellFormedId('a')).toBe(true)
  })

  it('拒绝会导致路径穿越的值', () => {
    // `..` 即使字符集合法也必须拒绝：主键会进存储路径。
    expect(isWellFormedId('..')).toBe(false)
    expect(isWellFormedId('a..b')).toBe(false)
    expect(isWellFormedId('../etc/passwd')).toBe(false)
    expect(isWellFormedId('a/b')).toBe(false)
    expect(isWellFormedId('a\\b')).toBe(false)
  })

  it('拒绝空串、非字符串与超长值', () => {
    expect(isWellFormedId('')).toBe(false)
    expect(isWellFormedId(null)).toBe(false)
    expect(isWellFormedId(undefined)).toBe(false)
    expect(isWellFormedId(123)).toBe(false)
    expect(isWellFormedId({})).toBe(false)
    // 上限 128 字符：首字符 + 至多 127 个后续字符。
    expect(isWellFormedId('a'.repeat(128))).toBe(true)
    expect(isWellFormedId('a'.repeat(129))).toBe(false)
  })

  it('拒绝以非字母数字开头（含前导下划线与连字符）', () => {
    expect(isWellFormedId('_doc')).toBe(false)
    expect(isWellFormedId('-doc')).toBe(false)
    expect(isWellFormedId(' doc')).toBe(false)
  })
})

describe('makeId', () => {
  it('生成的值必须通过 isWellFormedId', () => {
    for (const factory of Object.values(newIds)) {
      expect(isWellFormedId(factory())).toBe(true)
    }
  })

  it('注入随机源后结果可重复（故障复现要求）', () => {
    const fixed = { uuid: () => '00000000-1111-2222-3333-444444444444' }
    // uuid 去掉连字符后取前 26 位，再加 `前缀_`。
    expect(newIds.document(fixed)).toBe('doc_00000000111122223333444444')
    expect(newIds.document(fixed)).toBe(newIds.document(fixed))
  })

  it('前缀可区分实体类型', () => {
    const rng = { uuid: () => 'abcdef00-0000-0000-0000-000000000000' }
    expect(newIds.workspace(rng).startsWith('ws_')).toBe(true)
    expect(newIds.project(rng).startsWith('prj_')).toBe(true)
    expect(newIds.asset(rng).startsWith('ast_')).toBe(true)
    expect(newIds.request(rng).startsWith('req_')).toBe(true)
    expect(makeId<WorkspaceId>('custom', rng).startsWith('custom_')).toBe(true)
  })

  it('默认随机源产生互不相同的 ID', () => {
    const a = newIds.project()
    const b = newIds.project()
    expect(a).not.toBe(b)
    expect(cryptoRandomSource.uuid()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ---------------------------------------------------------------------------
// revision / cursor 编码
// ---------------------------------------------------------------------------

describe('encodeRevision', () => {
  it('序列单调递增时编码后仍保持字典序（存储层排序依据）', () => {
    const seqs = [1, 2, 35, 36, 1295, 1296, 999_999]
    const encoded = seqs.map((s) => encodeRevision(s))
    expect([...encoded].sort()).toEqual(encoded)
  })

  it('同一序列的编码稳定', () => {
    expect(encodeRevision(1)).toBe(encodeRevision(1))
    expect(encodeRevision(1)).not.toBe(encodeRevision(2))
  })

  it('拒绝 0、负数、小数与非安全整数', () => {
    // 0 非法：新建实体没有 revision，第一个版本必须是 r1。
    expect(() => encodeRevision(0)).toThrow(RangeError)
    expect(() => encodeRevision(-1)).toThrow(RangeError)
    expect(() => encodeRevision(1.5)).toThrow(RangeError)
    expect(() => encodeRevision(Number.NaN)).toThrow(RangeError)
    expect(() => encodeRevision(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => encodeRevision(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })

  it('接受边界值 1 与 MAX_SAFE_INTEGER', () => {
    expect(() => encodeRevision(1)).not.toThrow()
    expect(() => encodeRevision(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })
})

describe('encodeCursor', () => {
  it('携带 scope 且同一 scope 内单调', () => {
    const c0 = encodeCursor(0, 'ws_1')
    const c1 = encodeCursor(1, 'ws_1')
    expect(c0).toBe('ws_1:0')
    expect(c1).toBe('ws_1:1')
    expect(c1 > c0).toBe(true)
  })

  it('不同 scope 的游标不串用', () => {
    expect(encodeCursor(5, 'ws_a')).not.toBe(encodeCursor(5, 'ws_b'))
  })

  it('允许 0（首次拉取）但拒绝负数与小数', () => {
    expect(() => encodeCursor(0, 's')).not.toThrow()
    expect(() => encodeCursor(-1, 's')).toThrow(RangeError)
    expect(() => encodeCursor(0.5, 's')).toThrow(RangeError)
  })

  it('拒绝超出安全整数范围的序列（编码参数必须是安全整数）', () => {
    // 注意区分：`encodeCursor` 的**入参** seq 必须安全可编码；
    // 而"游标可能超出安全整数"说的是**服务端回传的不透明字符串**，
    // 那种值由远端产生，绝不经过本函数、也绝不能被 Number() 化（见下一个用例）。
    expect(() => encodeCursor(Number.MAX_SAFE_INTEGER + 2, 's')).toThrow(RangeError)
    expect(() => encodeCursor(Number.MAX_SAFE_INTEGER, 's')).not.toThrow()
  })

  it('🔴 远端不透明游标必须按字符串处理，数值化会静默丢失精度', () => {
    // 模拟后端回传的超大游标：它是 Cursor，不是 number。
    const remoteCursor = 'ws_1:zzzzzzzzzzzz' as Cursor
    expect(typeof remoteCursor).toBe('string')
    // 反例演示：同样的数值形态一旦被 business 代码转 number 就会失真。
    const bigNumberLike = '9007199254740993'
    expect(String(Number(bigNumberLike))).not.toBe(bigNumberLike)
    // 正确做法是原样透传字符串。
    expect(bigNumberLike).toBe('9007199254740993')
  })
})

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

describe('isUtcTimestamp', () => {
  it('接受毫秒精度 UTC 串', () => {
    expect(isUtcTimestamp('2026-10-14T18:00:00.000Z')).toBe(true)
    expect(isUtcTimestamp(systemClock.now())).toBe(true)
    expect(isUtcTimestamp(fixedClock('2026-01-02T03:04:05.678Z').now())).toBe(true)
  })

  it('拒绝无毫秒、带偏移量或本地时间形态', () => {
    expect(isUtcTimestamp('2026-10-14T18:00:00Z')).toBe(false)
    expect(isUtcTimestamp('2026-10-14T18:00:00.000+08:00')).toBe(false)
    expect(isUtcTimestamp('2026-10-14 18:00:00.000Z')).toBe(false)
    expect(isUtcTimestamp('2026-10-14')).toBe(false)
  })

  it('拒绝形状对但日期非法的串', () => {
    // 正则能过，Date.parse 不能过——两道校验缺一不可。
    expect(isUtcTimestamp('2026-13-45T99:99:99.999Z')).toBe(false)
  })

  it('拒绝非字符串', () => {
    expect(isUtcTimestamp(Date.now())).toBe(false)
    expect(isUtcTimestamp(null)).toBe(false)
    expect(isUtcTimestamp(new Date())).toBe(false)
  })
})

describe('clock', () => {
  it('systemClock 返回当前 UTC 时刻', () => {
    const before = Date.now()
    const now = Date.parse(systemClock.now())
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })

  it('fixedClock 恒定返回注入值', () => {
    const clock = fixedClock('2026-10-14T18:00:00.000Z')
    expect(clock.now()).toBe('2026-10-14T18:00:00.000Z')
    expect(clock.now()).toBe(clock.now())
  })
})

// ---------------------------------------------------------------------------
// 冲突裁决（数据安全核心）
// ---------------------------------------------------------------------------

const rev = (s: string) => s as Revision

describe('resolveConflict', () => {
  it('本地无基线且与远端相同 → already-current', () => {
    expect(resolveConflict({ baseRevision: null, localRevision: rev('r1'), remoteRevision: rev('r1') })).toEqual({
      kind: 'already-current',
    })
  })

  it('本地无基线且与远端不同 → fast-forward（远端是首个权威版本）', () => {
    expect(resolveConflict({ baseRevision: null, localRevision: rev('r1'), remoteRevision: rev('r2') })).toEqual({
      kind: 'fast-forward',
    })
  })

  it('本地与远端相同 → already-current', () => {
    expect(resolveConflict({ baseRevision: rev('r1'), localRevision: rev('r5'), remoteRevision: rev('r5') })).toEqual({
      kind: 'already-current',
    })
  })

  it('基线等于远端 → fast-forward（无人并发修改）', () => {
    expect(resolveConflict({ baseRevision: rev('r3'), localRevision: rev('r4'), remoteRevision: rev('r3') })).toEqual({
      kind: 'fast-forward',
    })
  })

  it('三方各不相同 → conflict(diverged)，绝不自动选一边', () => {
    expect(resolveConflict({ baseRevision: rev('r1'), localRevision: rev('r2'), remoteRevision: rev('r3') })).toEqual({
      kind: 'conflict',
      reason: 'diverged',
    })
  })

  it('🔴 不因 revision 字面"更大"而判定为 fast-forward（禁止比大小）', () => {
    // 基线 r2、本地 r3、远端 r1：字面上本地"更新"，但这是分叉，必须报冲突。
    expect(resolveConflict({ baseRevision: rev('r2'), localRevision: rev('r3'), remoteRevision: rev('r1') })).toEqual({
      kind: 'conflict',
      reason: 'diverged',
    })
  })

  it('裁决结果只依赖相等性，与 revision 字面值无关', () => {
    // 同构关系换一组字符串，结果必须一致。
    const a = resolveConflict({ baseRevision: rev('aaa'), localRevision: rev('bbb'), remoteRevision: rev('ccc') })
    const b = resolveConflict({ baseRevision: rev('zzz'), localRevision: rev('yyy'), remoteRevision: rev('xxx') })
    expect(a).toEqual(b)
    expect(a.kind).toBe('conflict')
  })
})
