import { describe, expect, it } from 'vitest'
import type { ErrorPayload, RequestId } from '@yfe/contracts'
import {
  BRIDGE_LEGACY_ERROR_CODES,
  FALLBACK_MESSAGE,
  clientError,
  describeThrown,
  errorResponseBody,
  fromThrown,
  isBridgeLegacyErrorCode,
  looksLikeStorageInternals,
  sanitizeDetail,
  sanitizeErrorPayload,
  sanitizeMessage,
  scrubText,
} from '../src/index.js'

const FALLBACK_ID = 'req_fallback' as RequestId

describe('sanitizeErrorPayload：按字段白名单重建', () => {
  it('剥掉 cause，丢弃所有契约之外的键，detail 原样保留（标量）', () => {
    const payload = sanitizeErrorPayload(
      {
        code: 'STORAGE_UNAVAILABLE',
        message: '本地库暂时不可用',
        requestId: 'req_main_1',
        severity: 'warn',
        retryable: true,
        detail: { attempt: 2 },
        cause: 'SQLITE_BUSY: database is locked',
        stack: 'Error: boom\n at x',
        anythingElse: '不该出现',
      },
      FALLBACK_ID,
    )
    expect(payload).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: '本地库暂时不可用',
      requestId: 'req_main_1',
      severity: 'warn',
      retryable: true,
      detail: { attempt: 2 },
    })
    expect(Object.keys(payload).sort()).toEqual(['code', 'detail', 'message', 'requestId', 'retryable', 'severity'])
  })

  it('severity/retryable 只在类型正确时沿用，否则按码推导', () => {
    const overridden = sanitizeErrorPayload(
      { code: 'STORAGE_UNAVAILABLE', message: 'x', requestId: 'req_1', severity: 'info', retryable: false },
      FALLBACK_ID,
    )
    expect(overridden.severity).toBe('info')
    expect(overridden.retryable).toBe(false)

    const derived = sanitizeErrorPayload(
      { code: 'STORAGE_UNAVAILABLE', message: 'x', requestId: 'req_1', severity: 'bogus', retryable: 'yes' },
      FALLBACK_ID,
    )
    expect(derived.severity).toBe('error')
    expect(derived.retryable).toBe(true)
  })

  it('message 里的绝对路径 → [path]，多行堆栈只留第一行', () => {
    expect(
      sanitizeErrorPayload(
        { code: 'INTERNAL_ERROR', message: '打开 D:\\yfe-data\\db.sqlite3 失败', requestId: 'req_2' },
        FALLBACK_ID,
      ).message,
    ).toBe('打开 [path] 失败')

    expect(
      sanitizeErrorPayload(
        { code: 'INTERNAL_ERROR', message: '读取失败\n    at readFile (C:\\yfe\\main.ts:12:9)', requestId: 'req_3' },
        FALLBACK_ID,
      ).message,
    ).toBe('读取失败')

    expect(
      sanitizeErrorPayload(
        { code: 'INTERNAL_ERROR', message: '无法写入 /Users/bob/yfe/db.sqlite3', requestId: 'req_4' },
        FALLBACK_ID,
      ).message,
    ).toBe('无法写入 [path]')
  })

  it('SQLite 原文不允许出现在 message 里（换成兜底文案）', () => {
    const payload = sanitizeErrorPayload(
      { code: 'STORAGE_CORRUPT', message: 'SQLITE_CORRUPT: database disk image is malformed', requestId: 'req_5' },
      FALLBACK_ID,
    )
    expect(payload.message).toBe(FALLBACK_MESSAGE)
    expect(JSON.stringify(payload)).not.toContain('SQLITE')
  })

  it('未知码折算成 INTERNAL_ERROR，原文进 detail.serverCode', () => {
    const payload = sanitizeErrorPayload(
      { code: 'TOTALLY_NEW_CODE', message: '新码', requestId: 'req_6' },
      FALLBACK_ID,
    )
    expect(payload.code).toBe('INTERNAL_ERROR')
    expect(payload.message).toBe(FALLBACK_MESSAGE)
    expect(payload.detail).toEqual({ serverCode: 'TOTALLY_NEW_CODE' })
  })

  it('非对象 / 缺 code / code 为空 → INTERNAL_ERROR，requestId 用调用方的兜底值', () => {
    const expected = {
      code: 'INTERNAL_ERROR',
      message: FALLBACK_MESSAGE,
      requestId: FALLBACK_ID,
      severity: 'error',
      retryable: false,
    }
    expect(sanitizeErrorPayload(null, FALLBACK_ID)).toEqual(expected)
    expect(sanitizeErrorPayload('boom', FALLBACK_ID)).toEqual(expected)
    expect(sanitizeErrorPayload(42, FALLBACK_ID)).toEqual(expected)
    expect(sanitizeErrorPayload([], FALLBACK_ID)).toEqual(expected)
    expect(sanitizeErrorPayload({ message: '缺码' }, FALLBACK_ID)).toEqual(expected)
    expect(sanitizeErrorPayload({ code: '', message: '空码' }, FALLBACK_ID)).toEqual(expected)
  })

  it('requestId 不是非空字符串时回落（空串 / 数字 / 缺失）', () => {
    for (const requestId of [undefined, '', 42, null, {}]) {
      const payload = sanitizeErrorPayload({ code: 'INTERNAL_ERROR', message: 'x', requestId }, FALLBACK_ID)
      expect(payload.requestId).toBe(FALLBACK_ID)
    }
  })

  it('桥接层遗留码逐字保留（契约闭集之外的唯一豁免）', () => {
    expect(BRIDGE_LEGACY_ERROR_CODES).toEqual(['PERMISSION_METHOD_NOT_ALLOWED'])
    expect(isBridgeLegacyErrorCode('PERMISSION_METHOD_NOT_ALLOWED')).toBe(true)
    expect(isBridgeLegacyErrorCode('PERMISSION_DENIED')).toBe(false)

    const payload = sanitizeErrorPayload(
      { code: 'PERMISSION_METHOD_NOT_ALLOWED', message: 'IPC 方法不在白名单: x', requestId: 'req_7' },
      FALLBACK_ID,
    )
    expect(payload.code).toBe('PERMISSION_METHOD_NOT_ALLOWED')
    expect(payload.severity).toBe('warn')
    expect(payload.retryable).toBe(false)
    expect(payload.detail).toBeUndefined()
  })
})

describe('sanitizeDetail：只留标量', () => {
  it('对象/数组/函数条目被丢弃，字符串条目同样过脱敏，null/布尔/数字保留', () => {
    const detail = sanitizeDetail({
      field: 'title',
      attempt: 3,
      ok: true,
      missing: null,
      nested: { a: 1 },
      list: [1, 2],
      fn: () => undefined,
      path: 'C:\\Users\\bob\\db.sqlite3',
      multiline: 'Error\n at x',
      notFinite: Number.POSITIVE_INFINITY,
    })
    expect(detail).toEqual({
      field: 'title',
      attempt: 3,
      ok: true,
      missing: null,
      path: '[path]',
      multiline: 'Error',
    })
  })

  it('非对象输入 / 空对象 → undefined', () => {
    expect(sanitizeDetail(null)).toBeUndefined()
    expect(sanitizeDetail('x')).toBeUndefined()
    expect(sanitizeDetail([1])).toBeUndefined()
    expect(sanitizeDetail({})).toBeUndefined()
    expect(sanitizeDetail({ nested: { a: 1 } })).toBeUndefined()
  })

  it('__proto__ / constructor / prototype 键被丢弃，不污染原型', () => {
    const detail =
      sanitizeDetail(JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","ok":1}') as unknown) ?? {}
    expect(detail).toEqual({ ok: 1 })
    expect(Object.getPrototypeOf(detail)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('文本脱敏工具', () => {
  it('scrubText：留第一行、折叠空白、路径占位、限长', () => {
    // 多行只留第一行（后续帧几乎必然是堆栈）；单行内折叠空白
    expect(scrubText('  a\n b \t c ')).toBe('a')
    expect(scrubText('  a \t b   c ')).toBe('a b c')
    expect(scrubText('/etc/passwd 读不到')).toBe('[path] 读不到')
    expect(scrubText('见 docs/adr/0006-renderer-architecture.md')).toBe('见 docs/adr/0006-renderer-architecture.md')
    expect(scrubText('https://example.com/a/b')).toBe('https://example.com/a/b')
    expect(scrubText('\\\\srv\\share\\x')).toBe('[path]')
    expect(scrubText('x'.repeat(500), 10)).toBe('xxxxxxxxxx…')
  })

  it('looksLikeStorageInternals：只认 SQLite 报错形态，不误伤正常文案', () => {
    expect(looksLikeStorageInternals('SQLITE_BUSY: database is locked')).toBe(true)
    expect(looksLikeStorageInternals('near "SELECT": syntax error')).toBe(true)
    expect(looksLikeStorageInternals('table documents has no column named foo')).toBe(true)
    expect(looksLikeStorageInternals('no such table: documents')).toBe(true)
    expect(looksLikeStorageInternals('本地库暂时不可用，请稍后重试')).toBe(false)
    expect(looksLikeStorageInternals('章节不存在')).toBe(false)
  })

  it('sanitizeMessage：非字符串/空串/存储原文 → 兜底文案', () => {
    expect(sanitizeMessage('章节不存在')).toBe('章节不存在')
    expect(sanitizeMessage(undefined)).toBe(FALLBACK_MESSAGE)
    expect(sanitizeMessage(42)).toBe(FALLBACK_MESSAGE)
    expect(sanitizeMessage('   ')).toBe(FALLBACK_MESSAGE)
    expect(sanitizeMessage('SQLITE_BUSY: database is locked')).toBe(FALLBACK_MESSAGE)
  })
})

describe('clientError：本地错误与远端错误同形状', () => {
  it('按码推导 severity/retryable，且永不带 cause', () => {
    expect(clientError('INTERNAL_ERROR', '内部错误', FALLBACK_ID, { reason: 'x' })).toEqual({
      code: 'INTERNAL_ERROR',
      message: '内部错误',
      requestId: FALLBACK_ID,
      severity: 'error',
      retryable: false,
      detail: { reason: 'x' },
    })
    expect(clientError('PERMISSION_METHOD_NOT_ALLOWED', '不在白名单', FALLBACK_ID).code).toBe(
      'PERMISSION_METHOD_NOT_ALLOWED',
    )
  })
})

describe('fromThrown', () => {
  it('native Error：只带一行 texto，无 cause/stack，可重试为 false', () => {
    const payload = fromThrown(new Error('boom'), FALLBACK_ID)
    expect(payload).toEqual({
      code: 'INTERNAL_ERROR',
      message: FALLBACK_MESSAGE,
      requestId: FALLBACK_ID,
      severity: 'error',
      retryable: false,
      detail: { reason: 'transport_threw', thrown: 'boom' },
    })
  })

  it('字符串 / undefined / null / 非 Error 对象：只给可安全外发的描述', () => {
    expect(fromThrown('通道关闭', FALLBACK_ID).detail?.['thrown']).toBe('通道关闭')
    expect(fromThrown(undefined, FALLBACK_ID).detail?.['thrown']).toBe('undefined')
    expect(fromThrown(null, FALLBACK_ID).detail?.['thrown']).toBe('null')
    // 非 Error 只给类型标签：String(obj) 是 [object Object]（无用），String(fn) 会泄漏源码
    expect(fromThrown({ code: 'X' }, FALLBACK_ID).detail?.['thrown']).toBe('非 Error 抛出物（typeof=object）')
    expect(fromThrown(() => undefined, FALLBACK_ID).detail?.['thrown']).toBe('非 Error 抛出物（typeof=function）')
    expect(fromThrown(42, FALLBACK_ID).detail?.['thrown']).toBe('非 Error 抛出物（typeof=number）')
  })

  it('无 message 的 Error 退化成 name，且路径被脱敏', () => {
    expect(describeThrown(new Error(''))).toBe('Error')
    expect(describeThrown(new Error('读取失败 C:\\yfe\\db.sqlite3'))).toBe('读取失败 [path]')
  })
})

describe('errorResponseBody：HTTP/RPC 适配', () => {
  it('不含 severity / cause / stack，只保留 code/message/requestId/retryable/detail', () => {
    const payload: ErrorPayload = {
      code: 'REVISION_CONFLICT',
      message: '版本冲突',
      requestId: 'req_1' as RequestId,
      severity: 'info',
      retryable: true,
      detail: { currentRevision: 'r1' },
      cause: 'stack trace here',
    }
    const body = errorResponseBody(payload)
    expect(body).toEqual({
      code: 'REVISION_CONFLICT',
      message: '版本冲突',
      requestId: 'req_1',
      retryable: true,
      detail: { currentRevision: 'r1' },
    })
    expect(Object.keys(body).sort()).toEqual(['code', 'detail', 'message', 'requestId', 'retryable'])
    for (const forbidden of ['severity', 'cause', 'stack']) {
      expect(forbidden in body).toBe(false)
    }
    expect(JSON.stringify(body)).not.toContain('stack trace')
  })

  it('message 里的绝对路径同样被脱敏；detail 为对象/数组时不产出 detail 字段', () => {
    const body = errorResponseBody(clientError('INTERNAL_ERROR', '打开 C:\\yfe\\db.sqlite3 失败', FALLBACK_ID))
    expect(body.message).toBe('打开 [path] 失败')
    expect('detail' in body).toBe(false)
  })

  it('畸形输入（null）不抛异常，回落成 INTERNAL_ERROR', () => {
    const body = errorResponseBody(null as unknown as ErrorPayload, FALLBACK_ID)
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      message: FALLBACK_MESSAGE,
      requestId: FALLBACK_ID,
      retryable: false,
    })
  })
})
