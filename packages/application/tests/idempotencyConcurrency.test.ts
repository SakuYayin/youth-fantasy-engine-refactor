import { ok, type IdempotencyKey, type RequestId } from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { createMemoryIdempotencyLedger, withIdempotency } from '../src/idempotency.js'
import type { IdempotencyPort } from '../src/ports.js'

const KEY = 'concurrent-key' as IdempotencyKey
const REQUEST = 'req-concurrent' as RequestId

describe('幂等队列释放与隔离', () => {
  it('读取失败不会卡住同键后续请求，后续请求仍重新读取并执行', async () => {
    const ledger = createMemoryIdempotencyLedger()
    let reads = 0
    let computed = 0
    const port: IdempotencyPort = {
      find: async (key) => {
        reads += 1
        if (reads === 1) throw new Error('read failed')
        return ledger.port.find(key)
      },
      save: (record) => ledger.port.save(record),
    }
    const run = () => withIdempotency(port, 'test', KEY, REQUEST, async () => {
      computed += 1
      return ok({ value: computed })
    }, 'same-request')

    const [failed, retried] = await Promise.all([run(), run()])
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.code).toBe('INTERNAL_ERROR')
    expect(retried).toEqual(ok({ value: 1 }))
    expect(reads).toBe(2)
    expect(computed).toBe(1)
  })

  it('compute 抛异常仍保留原始拒绝，并允许已排队请求继续执行', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const failure = new Error('compute failed')
    const results = await Promise.allSettled([
      withIdempotency(ledger.port, 'test', KEY, REQUEST, async () => { throw failure }, 'same-request'),
      withIdempotency(ledger.port, 'test', KEY, REQUEST, async () => ok({ value: 'retry' }), 'same-request'),
    ])

    expect(results[0]).toEqual({ status: 'rejected', reason: failure })
    expect(results[1]).toEqual({ status: 'fulfilled', value: ok({ value: 'retry' }) })
    expect(ledger.size()).toBe(1)
  })

  it('回执保存失败会返回失败并释放队列，不缓存未保存的结果', async () => {
    const ledger = createMemoryIdempotencyLedger()
    let saves = 0
    let computed = 0
    const port: IdempotencyPort = {
      find: (key) => ledger.port.find(key),
      save: async (record) => {
        saves += 1
        if (saves === 1) throw new Error('save failed')
        await ledger.port.save(record)
      },
    }
    const run = () => withIdempotency(port, 'test', KEY, REQUEST, async () => {
      computed += 1
      return ok({ value: computed })
    }, 'same-request')

    const [failed, retried] = await Promise.all([run(), run()])
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.code).toBe('INTERNAL_ERROR')
    expect(retried).toEqual(ok({ value: 2 }))
    expect(saves).toBe(2)
    expect(ledger.size()).toBe(1)
  })

  it('被阻塞的请求不阻止其他键及其他端口的同键请求', async () => {
    const first = createMemoryIdempotencyLedger()
    const second = createMemoryIdempotencyLedger()
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const pending = withIdempotency(first.port, 'test', KEY, REQUEST, async () => {
      started()
      await blocked
      return ok({ value: 'first' })
    }, 'first-request')
    await entered

    try {
      const outputs = await Promise.all([
        withIdempotency(first.port, 'test', 'another-key' as IdempotencyKey, REQUEST,
          async () => ok({ value: 'another-key' }), 'another-request'),
        withIdempotency(second.port, 'test', KEY, REQUEST,
          async () => ok({ value: 'another-port' }), 'another-request'),
      ])
      expect(outputs).toEqual([ok({ value: 'another-key' }), ok({ value: 'another-port' })])
    } finally {
      release()
      await pending
    }
    expect(first.size()).toBe(2)
    expect(second.size()).toBe(1)
  })
})
