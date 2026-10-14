/**
 * `@yfe/domain/orderKey` 契约测试。
 *
 * 这个模块只有两条性质是真正重要的，其余都是从属：
 *   1. **严格有序**：`orderKeyBetween(a, b)` 的结果恒满足 `a < 结果 < b`；
 *   2. **总能插入**：任意两键之间永远能再造一个新键，永不失败、永不要求重排兄弟。
 *
 * 顺序错了会直接表现为"用户拖完章节，重开又变回去"，所以这里用性质测试
 * （1000 次连续插入 + 随机插入）把不变量锁死，而不是只测几个样例。
 * 比较一律用 ASCII 字节序（与 SQLite `ORDER BY order_key` 一致），
 * 因此断言里刻意用裸 `<` 而不是 `localeCompare`。
 */

import { describe, expect, it } from 'vitest'

import {
  compareOrderKeys,
  isValidOrderKey,
  orderKeyAfter,
  orderKeyAt,
  orderKeyBefore,
  orderKeyBetween,
  sortByOrderKey,
  spreadOrderKeys,
} from '../src/orderKey/index.js'

/** 确定性伪随机（xorshift32）：测试可复现，不依赖 Math.random。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** 断言键合法且 `a < b`（ASCII）。 */
function expectOrdered(a: string, b: string): void {
  expect(isValidOrderKey(a), `非法键 ${JSON.stringify(a)}`).toBe(true)
  expect(isValidOrderKey(b), `非法键 ${JSON.stringify(b)}`).toBe(true)
  expect(a < b, `期望 ${JSON.stringify(a)} < ${JSON.stringify(b)}`).toBe(true)
}

// ---------------------------------------------------------------------------
// 基本形态
// ---------------------------------------------------------------------------

describe('orderKeyBetween', () => {
  it('空列表给出第一个键', () => {
    const key = orderKeyBetween(null, null)
    expect(isValidOrderKey(key)).toBe(true)
  })

  it('插到最前 / 插到最后', () => {
    const first = orderKeyBetween(null, null)
    const before = orderKeyBetween(null, first)
    const after = orderKeyBetween(first, null)

    expectOrdered(before, first)
    expectOrdered(first, after)
  })

  it('两端之间取中点', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyBetween(a, null)
    const mid = orderKeyBetween(a, b)

    expectOrdered(a, mid)
    expectOrdered(mid, b)
  })

  it('键是 ASCII 可比较的：与 SQLite BINARY 序一致', () => {
    // 键只能由 0-9A-Za-z 与 '.' 组成，因此 JS 的 `<` 与 SQLite 的 ORDER BY 同序。
    const keys = [orderKeyBetween(null, null), orderKeyAfter('A'.padEnd(27, '0')), spreadOrderKeys(5)[4] as string]
    for (const key of keys) {
      expect(key).toMatch(/^[0-9A-Za-z]+(\.[0-9A-Za-z]+)?$/)
      // 🔴 绝不能用 localeCompare：中文环境下它与 SQLite 分歧。
      expect(key < key.toUpperCase() || key.toUpperCase() <= key).toBe(true)
    }
  })

  it('orderKeyAfter / orderKeyBefore 是 orderKeyBetween 的简写', () => {
    const first = orderKeyBetween(null, null)
    expect(orderKeyAfter(first)).toBe(orderKeyBetween(first, null))
    expect(orderKeyBefore(first)).toBe(orderKeyBetween(null, first))
    expect(orderKeyAfter(null)).toBe(orderKeyBetween(null, null))
    expect(orderKeyBefore(null)).toBe(orderKeyBetween(null, null))
  })

  it('before >= after 时抛 RangeError（顺序颠倒必须显式报错）', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyAfter(a)
    expect(() => orderKeyBetween(b, a)).toThrow(RangeError)
    expect(() => orderKeyBetween(a, a)).toThrow(RangeError)
  })

  it('端点不是合法键时抛 RangeError', () => {
    expect(() => orderKeyBetween('', null)).toThrow(RangeError)
    expect(() => orderKeyBetween(null, '含中文')).toThrow(RangeError)
    // 🔴 小数末位为 '0' 的键非法：`"A"` 与 `"A.0"` 之间不存在可插入的键。
    expect(() => orderKeyBetween(orderKeyBetween(null, null), 'A0.0')).toThrow(RangeError)
    expect(() => orderKeyBetween(null, 'x'.repeat(600))).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// 合法性
// ---------------------------------------------------------------------------

describe('isValidOrderKey', () => {
  it('接受模块自己生成的键', () => {
    for (const key of [orderKeyBetween(null, null), orderKeyBetween(null, null) + '.5', 'A', 'zz']) {
      expect(isValidOrderKey(key), JSON.stringify(key)).toBe(true)
    }
  })

  it('拒绝空串、非字符串、超长', () => {
    expect(isValidOrderKey('')).toBe(false)
    expect(isValidOrderKey(null)).toBe(false)
    expect(isValidOrderKey(undefined)).toBe(false)
    expect(isValidOrderKey(42)).toBe(false)
    expect(isValidOrderKey({})).toBe(false)
    expect(isValidOrderKey('x'.repeat(513))).toBe(false)
  })

  it('拒绝非法字符（含会与 SQLite 分歧的 `-` / `_`）', () => {
    expect(isValidOrderKey('a-b')).toBe(false)
    expect(isValidOrderKey('a_b')).toBe(false)
    expect(isValidOrderKey('中')).toBe(false)
    expect(isValidOrderKey('a b')).toBe(false)
  })

  it('拒绝结构错误的小数部分', () => {
    expect(isValidOrderKey('A.')).toBe(false)
    expect(isValidOrderKey('.5')).toBe(false)
    expect(isValidOrderKey('A..5')).toBe(false)
    // 🔴 末位 '0' 会让"总能插入"失效。
    expect(isValidOrderKey('A.0')).toBe(false)
    expect(isValidOrderKey('A.10')).toBe(false)
    expect(isValidOrderKey('A.05')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 比较与排序
// ---------------------------------------------------------------------------

describe('compareOrderKeys / sortByOrderKey', () => {
  it('compareOrderKeys 返回可直接喂给 sort 的符号', () => {
    expect(compareOrderKeys('A', 'B')).toBeLessThan(0)
    expect(compareOrderKeys('B', 'A')).toBeGreaterThan(0)
    expect(compareOrderKeys('A', 'A')).toBe(0)
  })

  it('按 ASCII 序排序且不修改入参', () => {
    const keys = spreadOrderKeys(5)
    const shuffled = [keys[3], keys[0], keys[4], keys[1], keys[2]] as string[]
    const items = shuffled.map((orderKey, index) => ({ orderKey, index }))

    const sorted = sortByOrderKey(items)
    expect(sorted.map((item) => item.orderKey)).toEqual([...keys])
    expect(items.map((item) => item.orderKey)).toEqual(shuffled) // 入参未被改动
  })

  it('遇到非法 orderKey 抛错，而不是静默排到某处', () => {
    expect(() => sortByOrderKey([{ orderKey: 'ok' }, { orderKey: 'a-b' }])).toThrow(TypeError)
  })

  it('空数组安全', () => {
    expect(sortByOrderKey([])).toEqual([])
  })

  it('orderKeyAt 给出插入到该位置的键', () => {
    const keys = spreadOrderKeys(4)
    const items = keys.map((orderKey) => ({ orderKey }))

    const atStart = orderKeyAt(items, 0)
    expectOrdered(atStart, keys[0] as string)

    const atMiddle = orderKeyAt(items, 2)
    expectOrdered(keys[1] as string, atMiddle)
    expectOrdered(atMiddle, keys[2] as string)

    const atEnd = orderKeyAt(items, 4)
    expectOrdered(keys[3] as string, atEnd)
  })

  it('orderKeyAt 越界（负数 / 超长）退化为端点', () => {
    const keys = spreadOrderKeys(3)
    const items = keys.map((orderKey) => ({ orderKey }))
    expectOrdered(orderKeyAt(items, -5), keys[0] as string)
    expectOrdered(keys[2] as string, orderKeyAt(items, 99))
  })
})

// ---------------------------------------------------------------------------
// spreadOrderKeys
// ---------------------------------------------------------------------------

describe('spreadOrderKeys', () => {
  it('生成严格递增的键', () => {
    const keys = spreadOrderKeys(200)
    expect(keys).toHaveLength(200)
    for (let i = 1; i < keys.length; i += 1) {
      expectOrdered(keys[i - 1] as string, keys[i] as string)
    }
  })

  it('0 个返回空数组；负数与非整数抛 RangeError', () => {
    expect(spreadOrderKeys(0)).toEqual([])
    expect(() => spreadOrderKeys(-1)).toThrow(RangeError)
    expect(() => spreadOrderKeys(1.5)).toThrow(RangeError)
    expect(() => spreadOrderKeys(Number.NaN)).toThrow(RangeError)
    expect(() => spreadOrderKeys(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('铺开的键之间还有大量空间可插入', () => {
    const keys = spreadOrderKeys(3)
    const a = keys[0] as string
    const b = keys[1] as string
    let low = a
    for (let i = 0; i < 20; i += 1) {
      const next = orderKeyBetween(low, b)
      expectOrdered(low, next)
      expectOrdered(next, b)
      low = next
    }
  })
})

// ---------------------------------------------------------------------------
// 🔴 必需覆盖：连续插入 1000 次仍严格有序
// ---------------------------------------------------------------------------

describe('连续插入 1000 次仍严格有序', () => {
  it('每次追加到末尾，全序列严格递增且键长可控', () => {
    const keys: string[] = [orderKeyBetween(null, null)]
    for (let i = 1; i < 1000; i += 1) {
      keys.push(orderKeyAfter(keys[i - 1] as string))
    }

    expect(keys).toHaveLength(1000)
    for (let i = 1; i < keys.length; i += 1) {
      expectOrdered(keys[i - 1] as string, keys[i] as string)
    }
    // 追加走整数部分 +1，键长不该膨胀。
    const maxLength = Math.max(...keys.map((key) => key.length))
    expect(maxLength).toBeLessThanOrEqual(35)
    expect(new Set(keys).size).toBe(1000) // 无重复
  })

  it('每次插到最前，全序列严格递减（倒过来看）且键长可控', () => {
    const keys: string[] = [orderKeyBetween(null, null)]
    for (let i = 1; i < 1000; i += 1) {
      keys.unshift(orderKeyBefore(keys[0] as string))
    }

    expect(keys).toHaveLength(1000)
    for (let i = 1; i < keys.length; i += 1) {
      expectOrdered(keys[i - 1] as string, keys[i] as string)
    }
    const maxLength = Math.max(...keys.map((key) => key.length))
    expect(maxLength).toBeLessThanOrEqual(35)
  })

  it('反复插进同一个缝隙（最坏情况：整数部分贴死）', () => {
    // 两个相邻整数之间没有整数可用 → 必须靠小数部分二分，键长逐步 +1。
    const a = orderKeyBetween(null, null)
    const b = orderKeyAfter(a)

    const inserted: string[] = []
    let low = a
    for (let i = 0; i < 100; i += 1) {
      const next = orderKeyBetween(low, b)
      expectOrdered(low, next)
      expectOrdered(next, b)
      inserted.push(next)
      low = next
    }

    // 100 次嵌套仍远未触及上限，且全部互不相同。
    expect(new Set(inserted).size).toBe(100)
    expect(Math.max(...inserted.map((key) => key.length))).toBeLessThanOrEqual(150)
  })

  it('从中点不断向两侧扩张，两侧始终有序', () => {
    let low = orderKeyBetween(null, null)
    let high = orderKeyAfter(low)
    const below: string[] = []
    const above: string[] = []

    for (let i = 0; i < 300; i += 1) {
      low = orderKeyBetween(null, low)
      high = orderKeyAfter(high)
      below.push(low)
      above.push(high)
    }

    // `below` 按生成顺序是**递减**的（每次都在前一个之前），`above` 递增。
    for (let i = 1; i < below.length; i += 1) {
      expectOrdered(below[i] as string, below[i - 1] as string)
    }
    for (let i = 1; i < above.length; i += 1) {
      expectOrdered(above[i - 1] as string, above[i] as string)
    }
    // 最左端 < 最右端，且整体可以排序成一条严格递增序列。
    expectOrdered([...below].reverse()[below.length - 1] as string, above[0] as string)
    const all = [...below, orderKeyAfter(below[0] as string), ...above]
    const sorted = sortByOrderKey(all.map((orderKey) => ({ orderKey })))
    expect(sorted).toHaveLength(all.length)
  })
})

// ---------------------------------------------------------------------------
// 🔴 必需覆盖：随机插入不变量
// ---------------------------------------------------------------------------

describe('随机插入不变量', () => {
  it('1000 次随机位置插入：始终严格有序、无重复、每次只产生一个新键', () => {
    const random = createRandom(0x5eed)
    const keys: string[] = [orderKeyBetween(null, null)]

    for (let step = 0; step < 1000; step += 1) {
      const position = Math.floor(random() * (keys.length + 1))
      const before = position === 0 ? null : (keys[position - 1] as string)
      const after = position === keys.length ? null : (keys[position] as string)

      const key = orderKeyBetween(before, after)
      expect(isValidOrderKey(key)).toBe(true)
      if (before !== null) expect(before < key, `位置 ${position}：${before} !< ${key}`).toBe(true)
      if (after !== null) expect(key < after, `位置 ${position}：${key} !< ${after}`).toBe(true)

      keys.splice(position, 0, key)

      // 不变量：整条序列严格递增。
      for (let i = 1; i < keys.length; i += 1) {
        if (!((keys[i - 1] as string) < (keys[i] as string))) {
          throw new Error(`第 ${step} 步后在位置 ${i} 失序`)
        }
      }
    }

    expect(keys).toHaveLength(1001)
    expect(new Set(keys).size).toBe(1001)
  })

  it('相邻邻居之间插入：500 次随机缝隙插入始终严格有序、无重复', () => {
    const random = createRandom(0xc0ffee)
    const keys: string[] = spreadOrderKeys(50)

    for (let step = 0; step < 500; step += 1) {
      // 🔴 边界必须是**当前相邻**的两个键：这是产品里唯一真实的插入模式
      //    （拖动排序、`placement: { mode: 'after', afterId }` 都知道自己的左右邻居）。
      //    任取两个相距很远的键是**错的用法**——中点函数是确定性的，其返回值可能
      //    已经躺在列表里（见下一个用例），那样就会写出重复键并把排序打乱。
      const lo = Math.floor(random() * (keys.length - 1))
      const before = keys[lo] as string
      const after = keys[lo + 1] as string

      // 相邻缝隙里不存在第三个键 → 中点必然是新键，不需要重新平衡、不该抛错。
      const key = orderKeyBetween(before, after)
      expectOrdered(before, key)
      expectOrdered(key, after)

      keys.splice(lo + 1, 0, key)
    }

    // 不变量：整条序列严格递增且无重复。
    expect(new Set(keys).size).toBe(keys.length)
    for (let i = 1; i < keys.length; i += 1) {
      expectOrdered(keys[i - 1] as string, keys[i] as string)
    }
    const sorted = sortByOrderKey(keys.map((orderKey) => ({ orderKey })))
    expect(sorted.map((item) => item.orderKey)).toEqual(keys)
  })

  it('中点函数是确定性的：同一对边界必返回同一个键，所以调用方必须传当前邻居', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyAfter(a)

    /** 等距键（`spreadOrderKeys`）：用于演示下文第 2 点的"危险用法"。 */
    const spreadKeys = spreadOrderKeys(5)

    const mid = orderKeyBetween(a, b)
    expectOrdered(a, mid)
    expectOrdered(mid, b)

    // 1) 确定性是**契约**（纯函数），不是缺陷：重复调用同一对边界逐字相同。
    expect(orderKeyBetween(a, b)).toBe(mid)

    // 2) 危险用法：拿"相距很远的两个键"当边界，返回值可能**已经存在**。
    //    `spreadOrderKeys` 是等距的，所以 (第 1 个, 第 5 个) 的中点恰好等于第 3 个：
    expect(orderKeyBetween(spreadKeys[0] as string, spreadKeys[4] as string)).toBe(
      spreadKeys[2] as string,
    )
    // 更极端：等距键里任意"跨两格"的取中点都会撞上中间那个已存在的键。
    expect(orderKeyBetween(spreadKeys[1] as string, spreadKeys[3] as string)).toBe(
      spreadKeys[2] as string,
    )

    // 3) 安全用法：每次都用**当前相邻**邻居，永远拿得到新键，且越插越密。
    const left = orderKeyBetween(a, mid)
    const right = orderKeyBetween(mid, b)
    expectOrdered(a, left)
    expectOrdered(left, mid)
    expectOrdered(mid, right)
    expectOrdered(right, b)
    expect(new Set([a, left, mid, right, b]).size).toBe(5)

    // 4) 同一缝隙可以反复细分 200 次（小数位持续增长），不触发 MAX_KEY_LENGTH=512。
    let lo = a
    let hi = b
    for (let i = 0; i < 200; i += 1) {
      const next = orderKeyBetween(lo, hi)
      expectOrdered(lo, next)
      expectOrdered(next, hi)
      if (i % 2 === 0) hi = next
      else lo = next
    }
    expect(isValidOrderKey(hi)).toBe(true)

    // 5) 恒等边界与顺序颠倒一律抛 RangeError，绝不静默返回重复键。
    expect(() => orderKeyBetween(b, b)).toThrow(RangeError)
    expect(() => orderKeyBetween(b, a)).toThrow(RangeError)
  })

  it('生成的键恒满足 isValidOrderKey（含大量随机嵌套）', () => {
    const random = createRandom(0xabcdef)
    let low = orderKeyBetween(null, null)
    const high = orderKeyAfter(low)

    for (let step = 0; step < 300; step += 1) {
      const key =
        high > low && random() < 0.5 ? orderKeyBetween(low, high) : orderKeyBetween(low, null)
      expect(isValidOrderKey(key), `第 ${step} 步生成非法键 ${JSON.stringify(key)}`).toBe(true)
      expect(key > low).toBe(true)
      low = key
    }
  })

  it('随机插入后与"按插入顺序记录的位置"一致', () => {
    const random = createRandom(0x1234)
    interface Row {
      readonly orderKey: string
      readonly label: string
    }
    const rows: Row[] = []
    const expectedOrder: string[] = []

    for (let step = 0; step < 200; step += 1) {
      const position = Math.floor(random() * (rows.length + 1))
      const before = position === 0 ? null : (rows[position - 1]?.orderKey ?? null)
      const after = position === rows.length ? null : (rows[position]?.orderKey ?? null)
      const label = `row-${step}`

      const orderKey = orderKeyBetween(before, after)
      rows.splice(position, 0, { orderKey, label })
      expectedOrder.splice(position, 0, label)

      expect(sortByOrderKey(rows).map((row) => row.label)).toEqual(expectedOrder)
    }
  })
})

// ---------------------------------------------------------------------------
// 契约对齐：Document.orderKey 是 string
// ---------------------------------------------------------------------------

describe('与 @yfe/contracts 的形态对齐', () => {
  it('生成的键可以直接塞进 Document.orderKey（string）', () => {
    const document = {
      id: 'doc_1',
      projectId: 'prj_1',
      orderKey: orderKeyBetween(null, null),
      title: '第一章',
    }
    expect(typeof document.orderKey).toBe('string')
    expect(isValidOrderKey(document.orderKey)).toBe(true)
  })

  it('排序结果与 SQLite ORDER BY order_key 同序（BINARY 比较）', () => {
    // SQLite 的默认 BINARY 排序就是逐字节比较；这里用 Buffer 复现同一顺序。
    const keys = spreadOrderKeys(20)
    const shuffled = [...keys].reverse()
    const byJs = [...shuffled].sort((a, b) => compareOrderKeys(a, b))
    const byBytes = [...shuffled].sort((a, b) =>
      Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
    )
    expect(byJs).toEqual([...keys])
    expect(byBytes).toEqual(byJs)
  })
})
