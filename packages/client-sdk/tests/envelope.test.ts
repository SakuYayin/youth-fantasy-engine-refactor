import { describe, expect, it } from 'vitest'
import type { RequestId } from '@yfe/contracts'
import { MALFORMED_MESSAGE, parseResponseEnvelope } from '../src/index.js'
import * as f from './fixtures.js'

const CLIENT_REQUEST_ID = 'req_client_fixture' as RequestId

describe('parseResponseEnvelope：成功', () => {
  it('返回 ok(value)，值同引用透传（不做任何克隆/改写）', () => {
    const result = parseResponseEnvelope(
      f.successEnvelope('saveDraft', f.saveDraftOutput),
      'saveDraft',
      CLIENT_REQUEST_ID,
    )
    expect(f.expectOk(result).value).toBe(f.saveDraftOutput)
  })

  it('falsy 的 value（0 / "" / false / null）是合法值，不能当成"缺 value"', () => {
    for (const value of [0, '', false, null]) {
      const result = parseResponseEnvelope(
        f.successEnvelope('systemStatus', value),
        'systemStatus',
        CLIENT_REQUEST_ID,
      )
      expect(f.expectOk(result).value).toBe(value)
    }
  })
})

describe('parseResponseEnvelope：失败', () => {
  it('透传 code/message/severity/retryable/detail，剥掉 cause', () => {
    const result = parseResponseEnvelope(
      f.failureEnvelope('getDocument', {
        code: 'NOT_FOUND',
        message: '章节不存在',
        severity: 'info',
        retryable: false,
        detail: { documentId: 'doc_fixture1' },
        cause: 'ENOENT: /var/yfe/db.sqlite3',
      }),
      'getDocument',
      CLIENT_REQUEST_ID,
    )
    expect(f.expectErr(result).error).toEqual({
      code: 'NOT_FOUND',
      message: '章节不存在',
      requestId: f.MAIN_REQUEST_ID,
      severity: 'info',
      retryable: false,
      detail: { documentId: 'doc_fixture1' },
    })
  })

  it('请求 ID：优先信封里的非空值，缺失时回落调用方传入的值', () => {
    const fromEnvelope = f.expectErr(
      parseResponseEnvelope(
        f.failureEnvelope('saveDraft', { code: 'NOT_FOUND', message: 'x' }),
        'saveDraft',
        CLIENT_REQUEST_ID,
      ),
    ).error
    expect(fromEnvelope.requestId).toBe(f.MAIN_REQUEST_ID)

    const fromCaller = f.expectErr(
      parseResponseEnvelope(
        { kind: 'response', ok: false, method: 'saveDraft', error: { code: 'NOT_FOUND', message: 'x' } },
        'saveDraft',
        CLIENT_REQUEST_ID,
      ),
    ).error
    expect(fromCaller.requestId).toBe(CLIENT_REQUEST_ID)
  })

  it('未知契约码 → INTERNAL_ERROR，原文进 detail.serverCode（不冒充闭集里的码）', () => {
    const error = f.expectErr(
      parseResponseEnvelope(
        f.failureEnvelope('saveDraft', { code: 'TOTALLY_NEW_CODE', message: '新码' }),
        'saveDraft',
        CLIENT_REQUEST_ID,
      ),
    ).error
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.message).toBe('发生未预期的内部错误')
    expect(error.detail).toEqual({ serverCode: 'TOTALLY_NEW_CODE' })
  })

  it('桥接层遗留码 PERMISSION_METHOD_NOT_ALLOWED 逐字保留（不降级）', () => {
    const error = f.expectErr(
      parseResponseEnvelope(
        f.failureEnvelope('saveDraft', { code: 'PERMISSION_METHOD_NOT_ALLOWED', message: 'IPC 方法不在白名单' }),
        'saveDraft',
        CLIENT_REQUEST_ID,
      ),
    ).error
    expect(error.code).toBe('PERMISSION_METHOD_NOT_ALLOWED')
    expect(error.severity).toBe('warn')
    expect(error.retryable).toBe(false)
  })

  it('失败信封的 error 是数组/字符串 → 按缺 error 处理', () => {
    for (const bad of [[], 'boom', 42, null]) {
      const error = f.expectErr(
        parseResponseEnvelope(
          { kind: 'response', ok: false, method: 'saveDraft', error: bad },
          'saveDraft',
          CLIENT_REQUEST_ID,
        ),
      ).error
      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.detail?.['reason']).toBe('missing_error')
    }
  })
})

describe('parseResponseEnvelope：畸形一律失败', () => {
  it('所有畸形分支的 message 都是稳定文案，且 detail.reason 可机读', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, 'envelope_not_object'],
      [42, 'envelope_not_object'],
      [{ kind: 'response', ok: true, method: 'getDocument', value: 1 }, 'method_mismatch'],
      [{ kind: 'response', ok: true, method: 'saveDraft' }, 'missing_value'],
      [{ kind: 'response', ok: false, method: 'saveDraft' }, 'missing_error'],
      [{ kind: 'response', ok: false, method: 'saveDraft', error: {} }, 'missing_error_code'],
    ]
    for (const [raw, reason] of cases) {
      const error = f.expectErr(parseResponseEnvelope(raw, 'saveDraft', CLIENT_REQUEST_ID)).error
      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.message).toBe(MALFORMED_MESSAGE)
      expect(error.detail?.['reason']).toBe(reason)
      expect(error.detail?.['method']).toBe('saveDraft')
      expect(error.requestId).toBe(CLIENT_REQUEST_ID)
    }
  })

  it('method 缺失/非字符串（null、数字）都算串号，且 detail 只报告类型', () => {
    for (const method of [undefined, null, 42, {}, '']) {
      const error = f.expectErr(
        parseResponseEnvelope({ kind: 'response', ok: true, method, value: 1 }, 'saveDraft', CLIENT_REQUEST_ID),
      ).error
      expect(error.detail?.['reason']).toBe('method_mismatch')
      expect(Object.keys(error.detail ?? {}).sort()).toEqual(['envelopeMethodType', 'method', 'reason'])
    }
  })
})
