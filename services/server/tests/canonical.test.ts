import { describe, expect, it } from 'vitest'

import { canonicalJson, digestOf } from '../src/db/canonical.js'

describe('规范化载荷摘要', () => {
  it('保留嵌套 __proto__ 字段，避免不同 JSON 载荷共享幂等摘要', () => {
    const first: unknown = JSON.parse('{"nested":{"__proto__":{"text":"甲"}}}')
    const second: unknown = JSON.parse('{"nested":{"__proto__":{"text":"乙"}}}')
    expect(canonicalJson(first)).toBe('{"nested":{"__proto__":{"text":"甲"}}}')
    expect(digestOf(first)).not.toBe(digestOf(second))
    expect(digestOf(first)).not.toBe(digestOf({ nested: {} }))
  })
})
