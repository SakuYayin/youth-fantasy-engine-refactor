import { describe, expect, it, vi } from 'vitest'
import { ContractError, isErr, type RequestId } from '@yfe/contracts'
import { DEFAULT_TIMEOUT_MS, createClient, createRawInvoke, normalizeTimeout } from '../src/index.js'
import type { ClientTransport } from '../src/index.js'
import * as f from './fixtures.js'

// ---------------------------------------------------------------------------
// 正常成功：六个方法各一条，值逐字段（同引用）透传
// ---------------------------------------------------------------------------

describe('成功路径：六个方法逐字段透传', () => {
  it('saveDraft', async () => {
    const { transport, calls } = f.recordingTransport(() => f.successEnvelope('saveDraft', f.saveDraftOutput))
    const result = await createClient(transport).saveDraft(f.saveDraftInput)
    expect(f.expectOk(result).value).toBe(f.saveDraftOutput)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('saveDraft')
    expect(calls[0]?.payload).toBe(f.saveDraftInput)
  })

  it('listDocumentTree', async () => {
    const { transport, calls } = f.recordingTransport(() =>
      f.successEnvelope('listDocumentTree', f.documentTreeOutput),
    )
    const result = await createClient(transport).listDocumentTree(f.documentTreeInput)
    expect(f.expectOk(result).value).toBe(f.documentTreeOutput)
    expect(calls[0]?.method).toBe('listDocumentTree')
    expect(calls[0]?.payload).toBe(f.documentTreeInput)
  })

  it('getDocument', async () => {
    const { transport, calls } = f.recordingTransport(() => f.successEnvelope('getDocument', f.documentGetOutput))
    const result = await createClient(transport).getDocument(f.documentGetInput)
    expect(f.expectOk(result).value).toBe(f.documentGetOutput)
    expect(calls[0]?.method).toBe('getDocument')
    expect(calls[0]?.payload).toBe(f.documentGetInput)
  })

  it('createProject', async () => {
    const { transport, calls } = f.recordingTransport(() =>
      f.successEnvelope('createProject', f.projectCreateOutput),
    )
    const result = await createClient(transport).createProject(f.projectCreateInput)
    expect(f.expectOk(result).value).toBe(f.projectCreateOutput)
    expect(calls[0]?.method).toBe('createProject')
    expect(calls[0]?.payload).toBe(f.projectCreateInput)
  })

  it('createDocument', async () => {
    const { transport, calls } = f.recordingTransport(() =>
      f.successEnvelope('createDocument', f.documentCreateOutput),
    )
    const result = await createClient(transport).createDocument(f.documentCreateInput)
    expect(f.expectOk(result).value).toBe(f.documentCreateOutput)
    expect(calls[0]?.method).toBe('createDocument')
    expect(calls[0]?.payload).toBe(f.documentCreateInput)
  })

  it('systemStatus（无参方法载荷为 null）', async () => {
    const { transport, calls } = f.recordingTransport(() => f.successEnvelope('systemStatus', f.systemStatusOutput))
    const result = await createClient(transport).systemStatus()
    expect(f.expectOk(result).value).toBe(f.systemStatusOutput)
    expect(calls[0]?.method).toBe('systemStatus')
    expect(calls[0]?.payload).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 失败信封透传 + 脱敏
// ---------------------------------------------------------------------------

describe('失败信封', () => {
  it('code/message/severity/retryable/detail 保留，cause 与 stack 被剥掉', async () => {
    const { transport } = f.recordingTransport(() =>
      f.failureEnvelope('saveDraft', {
        code: 'REVISION_CONFLICT',
        message: '章节已在别处被修改',
        severity: 'info',
        retryable: false,
        detail: { currentRevision: 'r0000009' },
        cause: 'SQLITE_CONSTRAINT at C:\\Users\\bob\\yfe\\db.sqlite3',
        stack: 'Error: boom\n    at main.mjs:1:1',
      }),
    )
    const error = f.expectErr(await createClient(transport).saveDraft(f.saveDraftInput)).error

    expect(error.code).toBe('REVISION_CONFLICT')
    expect(error.message).toBe('章节已在别处被修改')
    expect(error.severity).toBe('info')
    expect(error.retryable).toBe(false)
    expect(error.detail).toEqual({ currentRevision: 'r0000009' })
    // 白名单重建：多带的键一个都留不下来
    expect('cause' in error).toBe(false)
    expect('stack' in error).toBe(false)
    expect(Object.keys(error).sort()).toEqual(['code', 'detail', 'message', 'requestId', 'retryable', 'severity'])
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('SQLITE')
    expect(serialized).not.toContain('db.sqlite3')
    expect(serialized).not.toContain('main.mjs')
  })

  it('失败信封的 requestId 保留 main 的值（便于日志串联）', async () => {
    const { transport } = f.recordingTransport(() =>
      f.failureEnvelope('getDocument', { code: 'NOT_FOUND', message: '章节不存在' }),
    )
    const error = f.expectErr(await createClient(transport).getDocument(f.documentGetInput)).error
    expect(error.requestId).toBe(f.MAIN_REQUEST_ID)
  })
})

// ---------------------------------------------------------------------------
// 畸形信封：绝不把畸形当成功
// ---------------------------------------------------------------------------

describe('畸形信封', () => {
  const cases: ReadonlyArray<{ readonly title: string; readonly raw: unknown; readonly reason: string }> = [
    { title: 'null', raw: null, reason: 'envelope_not_object' },
    { title: '字符串', raw: 'ok', reason: 'envelope_not_object' },
    { title: '数组', raw: [], reason: 'envelope_not_object' },
    { title: '{}', raw: {}, reason: 'kind_not_response' },
    {
      title: 'kind 不是 response',
      raw: { kind: 'event', ok: true, method: 'saveDraft', value: 1 },
      reason: 'kind_not_response',
    },
    {
      title: 'ok 非布尔',
      raw: { kind: 'response', ok: 'true', method: 'saveDraft', value: 1 },
      reason: 'ok_not_boolean',
    },
    {
      title: '方法名不匹配（串号）',
      raw: { kind: 'response', ok: true, method: 'getDocument', value: 1 },
      reason: 'method_mismatch',
    },
    {
      title: '成功但缺 value',
      raw: { kind: 'response', ok: true, method: 'saveDraft' },
      reason: 'missing_value',
    },
    {
      title: '成功但 value 为 undefined',
      raw: { kind: 'response', ok: true, method: 'saveDraft', value: undefined },
      reason: 'missing_value',
    },
    {
      title: '失败但缺 error',
      raw: { kind: 'response', ok: false, method: 'saveDraft' },
      reason: 'missing_error',
    },
    {
      title: '失败但缺 code',
      raw: { kind: 'response', ok: false, method: 'saveDraft', error: { message: 'x' } },
      reason: 'missing_error_code',
    },
  ]

  it.each(cases)('$title → INTERNAL_ERROR（detail.reason=$reason）', async ({ raw, reason }) => {
    const { transport, calls } = f.recordingTransport(() => raw)
    const error = f.expectErr(await createClient(transport).saveDraft(f.saveDraftInput)).error
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.detail?.['reason']).toBe(reason)
    expect(calls).toHaveLength(1)
  })

  it('串号检测只报告信封里 method 的类型，不回显对方的方法名（避免意外泄漏）', async () => {
    const { transport } = f.recordingTransport(() => ({
      kind: 'response',
      ok: true,
      method: 'deleteEverything',
      value: 1,
    }))
    const error = f.expectErr(await createClient(transport).saveDraft(f.saveDraftInput)).error
    expect(error.detail?.['envelopeMethodType']).toBe('string')
    expect(JSON.stringify(error)).not.toContain('deleteEverything')
  })
})

// ---------------------------------------------------------------------------
// 白名单守卫
// ---------------------------------------------------------------------------

describe('白名单守卫（白名单外的方法不发往 transport）', () => {
  it('PERMISSION_METHOD_NOT_ALLOWED：transport 未被调用，也没有建立任何定时器', async () => {
    vi.useFakeTimers()
    try {
      const { transport, calls } = f.recordingTransport(() => f.successEnvelope('saveDraft', f.saveDraftOutput))
      const error = f.expectErr(await createRawInvoke(transport)('deleteEverything', { all: true })).error

      // 桥接层实际在用的字面量（preload.cjs:52 / main.mjs:354 / ADR D2 第 5 条）
      expect(error.code).toBe('PERMISSION_METHOD_NOT_ALLOWED')
      expect(error.message).toContain('deleteEverything')
      expect(error.severity).toBe('warn')
      expect(error.retryable).toBe(false)
      expect(error.detail).toEqual({ reason: 'method_not_whitelisted' })
      expect(calls).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('空串 / 大小写不同 / 尾部空格 / 原型链上的名字 一律被拒', async () => {
    const { transport, calls } = f.recordingTransport(() => f.successEnvelope('saveDraft', f.saveDraftOutput))
    const invoke = createRawInvoke(transport)
    for (const method of ['', 'Savedraft', 'saveDraft ', 'save_draft', 'constructor', '__proto__', 'toString']) {
      const error = f.expectErr(await invoke(method, null)).error
      expect(error.code).toBe('PERMISSION_METHOD_NOT_ALLOWED')
    }
    expect(calls).toEqual([])
  })

  it('transport 不可用（不是 { call }）→ INTERNAL_ERROR，且不抛异常', async () => {
    const broken = { notCall: () => undefined } as unknown as ClientTransport
    const error = f.expectErr(await createClient(broken).systemStatus()).error
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.detail).toEqual({ reason: 'transport_unavailable' })
    expect(error.message).not.toContain('notCall')
  })
})

// ---------------------------------------------------------------------------
// transport 抛异常
// ---------------------------------------------------------------------------

describe('transport 抛异常', () => {
  it.each([
    ['native Error', (): unknown => new Error('boom')],
    ['字符串', (): unknown => 'IPC 通道已关闭'],
    ['undefined', (): unknown => undefined],
  ])('%s → INTERNAL_ERROR（retryable:false），无 cause/stack', async (_name, make) => {
    const calls: string[] = []
    const transport: ClientTransport = {
      call: (method) => {
        calls.push(method)
        return Promise.reject(make())
      },
    }
    const error = f.expectErr(await createClient(transport).getDocument(f.documentGetInput)).error
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.retryable).toBe(false)
    expect('cause' in error).toBe(false)
    expect('stack' in error).toBe(false)
    expect(error.detail?.['reason']).toBe('transport_threw')
    expect(calls).toEqual(['getDocument'])
  })

  it('抛出物文本仍然脱敏：只留第一行，绝对路径 → [path]', async () => {
    const transport: ClientTransport = {
      call: () => Promise.reject(new Error('读取失败 D:\\yfe-data\\db.sqlite3\n    at main.mjs:12:9')),
    }
    const error = f.expectErr(await createClient(transport).systemStatus()).error
    expect(error.detail).toEqual({ reason: 'transport_threw', thrown: '读取失败 [path]' })
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('sqlite3')
    expect(serialized).not.toContain('main.mjs')
  })

  it('同步抛出（不是 reject）同样被兜住', async () => {
    const transport = {
      call: () => {
        throw new Error('sync boom')
      },
    } as unknown as ClientTransport
    const error = f.expectErr(await createClient(transport).systemStatus()).error
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.detail).toEqual({ reason: 'transport_threw', thrown: 'sync boom' })
  })

  it('ContractError 按自身稳定码折算，cause 被剥掉', async () => {
    const thrown = new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '本地库暂时不可用',
      requestId: 'req_main_x' as RequestId,
      cause: 'SQLITE_BUSY: database is locked',
    })
    const transport: ClientTransport = { call: () => Promise.reject(thrown) }
    const error = f.expectErr(await createClient(transport).saveDraft(f.saveDraftInput)).error
    expect(error.code).toBe('STORAGE_UNAVAILABLE')
    expect(error.retryable).toBe(true)
    expect('cause' in error).toBe(false)
    expect(JSON.stringify(error)).not.toContain('SQLITE')
  })
})

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

describe('超时', () => {
  it('超出定时器上限的配置回退默认超时，不会溢出成 1ms', async () => {
    vi.useFakeTimers()
    try {
      const deferred = f.deferredTransport()
      const pending = createClient(deferred.transport, { timeoutMs: 2_147_483_648 }).systemStatus()
      let settled = false
      void pending.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      const error = f.expectErr(await pending).error
      expect(error.code).toBe('NETWORK_TIMEOUT')
      expect(error.detail?.['timeoutMs']).toBe(DEFAULT_TIMEOUT_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('默认 15000ms：到点前不结算；到点后 NETWORK_TIMEOUT/retryable:true；定时器已清理；迟到结果被忽略', async () => {
    vi.useFakeTimers()
    try {
      const deferred = f.deferredTransport()
      const pending = createClient(deferred.transport).saveDraft(f.saveDraftInput)
      let settled = false
      void pending.then(() => {
        settled = true
      })

      // 计时器在调用进入时同步建立，且覆盖 transport 往返本身
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      const first = await pending
      const error = f.expectErr(first).error
      expect(error.code).toBe('NETWORK_TIMEOUT')
      expect(error.retryable).toBe(true)
      expect(error.detail).toEqual({ reason: 'timeout', method: 'saveDraft', timeoutMs: DEFAULT_TIMEOUT_MS })
      // 未清理的 timer 会把进程拖住
      expect(vi.getTimerCount()).toBe(0)

      // 迟到的成功回包不得改写已定结论
      deferred.resolve(f.successEnvelope('saveDraft', f.saveDraftOutput))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(await pending).toBe(first)
      expect(isErr(await pending)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeoutMs 由 options 覆盖生效（50ms）', async () => {
    vi.useFakeTimers()
    try {
      const deferred = f.deferredTransport()
      const pending = createClient(deferred.transport, { timeoutMs: 50 }).systemStatus()
      await vi.advanceTimersByTimeAsync(49)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      const error = f.expectErr(await pending).error
      expect(error.code).toBe('NETWORK_TIMEOUT')
      expect(error.detail).toEqual({ reason: 'timeout', method: 'systemStatus', timeoutMs: 50 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时后迟到的 reject 不产生 unhandledRejection（audit-only）', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const transport: ClientTransport = {
        call: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late failure')), 30)
          }),
      }
      const error = f.expectErr(await createClient(transport, { timeoutMs: 5 }).saveDraft(f.saveDraftInput)).error
      expect(error.code).toBe('NETWORK_TIMEOUT')
      await f.delay(60)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('normalizeTimeout：非法值回落默认值，绝不把 0 当成"立即超时"', () => {
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [undefined, DEFAULT_TIMEOUT_MS],
      [null, DEFAULT_TIMEOUT_MS],
      [0, DEFAULT_TIMEOUT_MS],
      [-1, DEFAULT_TIMEOUT_MS],
      [Number.NaN, DEFAULT_TIMEOUT_MS],
      [Number.POSITIVE_INFINITY, DEFAULT_TIMEOUT_MS],
      [2_147_483_648, DEFAULT_TIMEOUT_MS],
      [Number.MAX_SAFE_INTEGER, DEFAULT_TIMEOUT_MS],
      ['5000', DEFAULT_TIMEOUT_MS],
      [1, 1],
      [250, 250],
      [2_147_483_647, 2_147_483_647],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeTimeout(input)).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// 健壮性：非 Promise 返回值
// ---------------------------------------------------------------------------

describe('健壮性', () => {
  it('transport 同步返回信封（不是 Promise）也能正确处理', async () => {
    // preload 的 call 是 async，但 mock/替身可能同步返回；这里锁住"不因此崩掉"。
    const syncTransport = {
      call: (() => f.successEnvelope('systemStatus', f.systemStatusOutput)) as unknown as ClientTransport['call'],
    }
    const result = await createClient(syncTransport).systemStatus()
    expect(f.expectOk(result).value).toBe(f.systemStatusOutput)
  })

  it('并发调用互不串号：每个请求的信封各归其主', async () => {
    const transport: ClientTransport = {
      call: (method) => {
        if (method === 'getDocument') return Promise.resolve(f.successEnvelope('getDocument', f.documentGetOutput))
        if (method === 'systemStatus') return Promise.resolve(f.successEnvelope('systemStatus', f.systemStatusOutput))
        return Promise.resolve(f.successEnvelope(method, f.saveDraftOutput))
      },
    }
    const client = createClient(transport)
    const [saved, doc, status] = await Promise.all([
      client.saveDraft(f.saveDraftInput),
      client.getDocument(f.documentGetInput),
      client.systemStatus(),
    ])
    expect(f.expectOk(saved).value).toBe(f.saveDraftOutput)
    expect(f.expectOk(doc).value).toBe(f.documentGetOutput)
    expect(f.expectOk(status).value).toBe(f.systemStatusOutput)
  })
})
