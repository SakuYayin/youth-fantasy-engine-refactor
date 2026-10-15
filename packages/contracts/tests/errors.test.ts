/**
 * errors 契约测试。
 *
 * 这块是**跨端错误分类的唯一真相**：IPC 与 HTTP 都按 `code` 分支而不是比较中文，
 * 所以分类表一旦错了，表现是"某些错误在 UI 上永远不给重试按钮"这类静默故障。
 * 测试因此覆盖：分类完备性、严重度表、可重试判定的边界，以及异常归一化不泄漏堆栈。
 */

import { describe, expect, it } from 'vitest'

import {
  ContractError,
  ERROR_CODES,
  err,
  errOf,
  isErr,
  isErrorCode,
  isOk,
  isRetryable,
  ok,
  severityOf,
  toErrorPayload,
  unwrap,
} from '../src/errors.js'
import type { ErrorCode, Result } from '../src/errors.js'
import { newIds } from '../src/ids.js'
import type { RequestId } from '../src/ids.js'

const reqId = (): RequestId => newIds.request()

// ---------------------------------------------------------------------------
// 错误码集合
// ---------------------------------------------------------------------------

describe('ERROR_CODES', () => {
  it('无重复项（重复会让 CODE_SET 静默吞掉一个）', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })

  it('数量与设计基线一致（66 个，新增必须是有意为之）', () => {
    // 59 → 66：W7 加 AI_ 组 7 个（渲染层 AI 三件套的传输层码），R-35——这里写死的
    // 数字必须随有意的新组一起更新，评审点在 diff 里。
    expect(ERROR_CODES.length).toBe(66)
  })

  it('各分类的码数量符合契约（新增码会打破这里的断言，迫使评审）', () => {
    const countByPrefix = (prefix: string): number => ERROR_CODES.filter((c) => c.startsWith(prefix)).length
    expect(countByPrefix('VALIDATION_')).toBe(5) // 不含 PAYLOAD_TOO_LARGE
    expect(ERROR_CODES).toContain('PAYLOAD_TOO_LARGE')
    expect(countByPrefix('AUTH_')).toBe(5)
    expect(countByPrefix('PERMISSION_')).toBe(4)
    expect(countByPrefix('NOT_FOUND')).toBe(6)
    expect(countByPrefix('STORAGE_')).toBe(6)
    expect(countByPrefix('NETWORK_')).toBe(4)
    expect(countByPrefix('SYNC_')).toBe(6)
    expect(countByPrefix('JOB_')).toBe(6)
    expect(countByPrefix('PLUGIN_')).toBe(5)
    expect(countByPrefix('SERVICE_')).toBe(3) // INTERNAL_ERROR / NOT_IMPLEMENTED 无此前缀
    expect(countByPrefix('AI_')).toBe(7) // W7 渲染层 AI 三件套
    expect(ERROR_CODES).toContain('INTERNAL_ERROR')
    expect(ERROR_CODES).toContain('NOT_IMPLEMENTED')
  })

  it('全部为大写蛇形，且带已知分类前缀', () => {
    const knownPrefixes = [
      'VALIDATION_',
      'PAYLOAD_TOO_LARGE',
      'AUTH_',
      'PERMISSION_',
      'NOT_FOUND',
      'REVISION_CONFLICT',
      'IDEMPOTENCY_KEY_REUSED',
      'STATE_INVALID_TRANSITION',
      'RESOURCE_LOCKED',
      'ALREADY_EXISTS',
      'WORKSPACE_ALREADY_AUTHORITATIVE',
      'STORAGE_',
      'NETWORK_',
      'SYNC_',
      'JOB_',
      'PLUGIN_',
      'SERVICE_',
      'AI_',
      'INTERNAL_ERROR',
      'NOT_IMPLEMENTED',
    ]
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(knownPrefixes.some((p) => code.startsWith(p))).toBe(true)
    }
  })

  it('每个错误码都能被 severityOf 与 isRetryable 处理而不抛错', () => {
    for (const code of ERROR_CODES) {
      expect(['info', 'warn', 'error', 'critical']).toContain(severityOf(code))
      expect(typeof isRetryable(code)).toBe('boolean')
    }
  })

  it('isErrorCode 精确匹配，不做前缀或大小写放宽', () => {
    expect(isErrorCode('REVISION_CONFLICT')).toBe(true)
    expect(isErrorCode('revision_conflict')).toBe(false)
    expect(isErrorCode('REVISION_CONFLICTX')).toBe(false)
    expect(isErrorCode('UNKNOWN_CODE')).toBe(false)
    expect(isErrorCode('')).toBe(false)
    expect(isErrorCode(null)).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 严重度
// ---------------------------------------------------------------------------

describe('severityOf', () => {
  it('数据可靠性受威胁的码必须是 critical', () => {
    // 这三条意味着"数据可能已经不对了"，UI 必须阻断而不是提示重试。
    expect(severityOf('STORAGE_DISK_FULL')).toBe('critical')
    expect(severityOf('STORAGE_CORRUPT')).toBe('critical')
    expect(severityOf('STORAGE_SCHEMA_TOO_NEW')).toBe('critical')
  })

  it('预期内业务分支是 info', () => {
    expect(severityOf('VALIDATION_FAILED')).toBe('info')
    expect(severityOf('NOT_FOUND_DOCUMENT')).toBe('info')
    expect(severityOf('REVISION_CONFLICT')).toBe('info')
    expect(severityOf('ALREADY_EXISTS')).toBe('info')
    expect(severityOf('JOB_CANCELLED')).toBe('info')
  })

  it('可恢复的环境问题是 warn', () => {
    expect(severityOf('AUTH_REQUIRED')).toBe('warn')
    expect(severityOf('PERMISSION_DENIED')).toBe('warn')
    expect(severityOf('NETWORK_TIMEOUT')).toBe('warn')
    expect(severityOf('SYNC_CURSOR_INVALID')).toBe('warn')
    expect(severityOf('PLUGIN_DISABLED')).toBe('warn')
    expect(severityOf('NOT_IMPLEMENTED')).toBe('warn')
  })

  it('服务端与内部故障是 error', () => {
    expect(severityOf('SERVICE_UNAVAILABLE')).toBe('error')
    expect(severityOf('INTERNAL_ERROR')).toBe('error')
  })

  it('更具体的前缀优先于泛化前缀（表顺序即优先级）', () => {
    // STORAGE_SCHEMA_TOO_NEW 同时匹配 'STORAGE_'，必须命中更靠前的 critical 条目。
    expect(severityOf('STORAGE_SCHEMA_TOO_NEW')).not.toBe('error')
    // JOB_CANCELLED 同时匹配 'JOB_'，必须是 info 而非 warn。
    expect(severityOf('JOB_CANCELLED')).not.toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// 可重试判定
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('网络类可重试', () => {
    expect(isRetryable('NETWORK_UNAVAILABLE')).toBe(true)
    expect(isRetryable('NETWORK_TIMEOUT')).toBe(true)
    expect(isRetryable('NETWORK_SERVER_ERROR')).toBe(true)
    expect(isRetryable('NETWORK_TLS_FAILED')).toBe(true)
  })

  it('同步目标不可达可重试，协议/数据类不可重试', () => {
    expect(isRetryable('SYNC_TARGET_UNREACHABLE')).toBe(true)
    expect(isRetryable('SYNC_PROTOCOL_MISMATCH')).toBe(false)
    expect(isRetryable('SYNC_CURSOR_INVALID')).toBe(false)
    expect(isRetryable('SYNC_BATCH_REJECTED')).toBe(false)
  })

  it('info 级里只有冲突与锁可重试', () => {
    expect(isRetryable('REVISION_CONFLICT')).toBe(true)
    expect(isRetryable('RESOURCE_LOCKED')).toBe(true)
    expect(isRetryable('VALIDATION_FAILED')).toBe(false)
    expect(isRetryable('NOT_FOUND')).toBe(false)
    expect(isRetryable('ALREADY_EXISTS')).toBe(false)
  })

  it('🔴 权限与认证失败绝不重试（否则会形成无意义的登录风暴）', () => {
    expect(isRetryable('PERMISSION_DENIED')).toBe(false)
    expect(isRetryable('PERMISSION_WORKSPACE_MISMATCH')).toBe(false)
    expect(isRetryable('AUTH_INVALID_CREDENTIALS')).toBe(false)
    expect(isRetryable('AUTH_DEVICE_REVOKED')).toBe(false)
  })

  it('🔴 disk full / read-only / corrupt 绝不重试（重试只会刷屏且掩盖根因）', () => {
    expect(isRetryable('STORAGE_DISK_FULL')).toBe(false)
    expect(isRetryable('STORAGE_READ_ONLY')).toBe(false)
    expect(isRetryable('STORAGE_CORRUPT')).toBe(false)
    expect(isRetryable('STORAGE_SCHEMA_TOO_NEW')).toBe(false)
  })

  it('校验失败不重试，服务暂不可用可重试', () => {
    expect(isRetryable('VALIDATION_MALFORMED_ID')).toBe(false)
    expect(isRetryable('PAYLOAD_TOO_LARGE')).toBe(false)
    expect(isRetryable('SERVICE_UNAVAILABLE')).toBe(true)
    expect(isRetryable('JOB_EXECUTOR_FAILED')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ContractError
// ---------------------------------------------------------------------------

describe('ContractError', () => {
  it('未显式传 severity/retryable 时按 code 推导', () => {
    const e = new ContractError({ code: 'NETWORK_TIMEOUT', message: '网络超时', requestId: reqId() })
    expect(e.severity).toBe('warn')
    expect(e.retryable).toBe(true)
  })

  it('可显式覆盖推导值', () => {
    const e = new ContractError({
      code: 'NETWORK_TIMEOUT',
      message: '网络超时',
      requestId: reqId(),
      severity: 'critical',
      retryable: false,
    })
    expect(e.severity).toBe('critical')
    expect(e.retryable).toBe(false)
  })

  it('是 Error 子类，message 与 name 正确', () => {
    const e = new ContractError({ code: 'NOT_FOUND', message: '作品不存在', requestId: reqId() })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ContractError')
    expect(e.message).toBe('作品不存在')
  })

  it('toPayload 保留 code/message/requestId 与 detail', () => {
    const requestId = reqId()
    const e = new ContractError({
      code: 'REVISION_CONFLICT',
      message: '正文已被其他窗口修改',
      requestId,
      detail: { documentId: 'doc_1', expectedRevision: 'r00000001', currentRevision: 'r00000002' },
    })
    expect(e.toPayload()).toEqual({
      code: 'REVISION_CONFLICT',
      message: '正文已被其他窗口修改',
      requestId,
      severity: 'info',
      retryable: true,
      detail: { documentId: 'doc_1', expectedRevision: 'r00000001', currentRevision: 'r00000002' },
    })
  })

  it('🔴 toPayload 不携带 cause（cause 仅本地调试，绝不外发）', () => {
    const e = new ContractError({
      code: 'INTERNAL_ERROR',
      message: '内部错误',
      requestId: reqId(),
      cause: 'SQLITE_BUSY: database is locked',
    })
    expect(e.cause).toBe('SQLITE_BUSY: database is locked')
    expect(e.toPayload()).not.toHaveProperty('cause')
  })

  it('detail 未传时 payload 不含该键（避免 undefined 穿透序列化）', () => {
    const e = new ContractError({ code: 'INTERNAL_ERROR', message: 'x', requestId: reqId() })
    expect(Object.keys(e.toPayload())).not.toContain('detail')
  })
})

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

describe('Result', () => {
  it('ok 把成功值包在 value 字段里', () => {
    const r = ok({ revision: 'r00000001' })
    expect(r).toEqual({ ok: true, value: { revision: 'r00000001' } })
  })

  it('ok 支持 undefined 值（不代表失败）', () => {
    const r = ok(undefined)
    expect(isOk(r)).toBe(true)
    expect(r.value).toBeUndefined()
  })

  it('isOk / isErr 严格互斥', () => {
    const good: Result<number> = ok(1)
    const bad: Result<number> = errOf('NOT_FOUND', '不存在', reqId())
    expect(isOk(good)).toBe(true)
    expect(isErr(good)).toBe(false)
    expect(isOk(bad)).toBe(false)
    expect(isErr(bad)).toBe(true)
  })

  it('失败分支只暴露结构化的 error 载荷', () => {
    const r = errOf('VALIDATION_FAILED', '标题不能为空', reqId(), { field: 'title' })
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('VALIDATION_FAILED')
    expect(r.error.severity).toBe('info')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toEqual({ field: 'title' })
  })

  it('errOf 未传 detail 时不留空对象', () => {
    const r = errOf('NOT_FOUND', '不存在', reqId())
    expect(r.error).not.toHaveProperty('detail')
  })

  it('err 接受现成载荷（用于把已归一的错误向上传）', () => {
    const payload = toErrorPayload(new Error('boom'), reqId())
    expect(err(payload).error).toBe(payload)
  })

  it('unwrap 成功时返回值，失败时抛 ContractError', () => {
    expect(unwrap(ok(7))).toBe(7)
    const requestId = reqId()
    const failure = errOf('STORAGE_DISK_FULL', '磁盘已满', requestId)
    expect(() => unwrap(failure)).toThrow(ContractError)
    try {
      unwrap(failure)
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError)
      expect((e as ContractError).code).toBe('STORAGE_DISK_FULL')
      expect((e as ContractError).requestId).toBe(requestId)
      // 失败载荷的 retryable 必须原样带出，不能被重新推导成 true。
      expect((e as ContractError).retryable).toBe(false)
    }
  })

  it('detail 值类型限定为可序列化原始值', () => {
    const r = errOf('VALIDATION_OUT_OF_RANGE', '超出范围', reqId(), {
      min: 0,
      max: 100,
      actual: 101,
      hint: '请缩小范围',
      optional: null,
    })
    for (const v of Object.values(r.error.detail ?? {})) {
      expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 异常归一化
// ---------------------------------------------------------------------------

describe('toErrorPayload', () => {
  it('ContractError 原样返回自身载荷（保留业务语义）', () => {
    const requestId = reqId()
    const original = new ContractError({
      code: 'REVISION_CONFLICT',
      message: '冲突',
      requestId,
      detail: { a: 1 },
    })
    expect(toErrorPayload(original, reqId())).toEqual(original.toPayload())
  })

  it('普通 Error 归一为 INTERNAL_ERROR，并把 message 放进 cause', () => {
    const requestId = reqId()
    const payload = toErrorPayload(new Error('SQLITE_BUSY'), requestId, '保存失败')
    expect(payload.code).toBe('INTERNAL_ERROR')
    expect(payload.message).toBe('保存失败')
    expect(payload.requestId).toBe(requestId)
    expect(payload.retryable).toBe(false)
    expect(payload.cause).toBe('SQLITE_BUSY')
  })

  it('非 Error 抛出物同样归一，不泄漏其内容为 message', () => {
    const payload = toErrorPayload({ secret: 'token' }, reqId())
    expect(payload.code).toBe('INTERNAL_ERROR')
    expect(payload.message).toBe('发生未预期的内部错误')
    expect(payload.cause).toBe('[object Object]')
  })

  it('🔴 绝不泄漏堆栈（堆栈可能含绝对路径与用户名）', () => {
    const thrown = new Error('boom')
    thrown.stack = 'Error: boom\n    at C:\\Users\\压音\\app.js:1:1'
    const payload = toErrorPayload(thrown, reqId())
    expect(JSON.stringify(payload)).not.toContain('at C:')
    expect(JSON.stringify(payload)).not.toContain('压音')
    expect(payload).not.toHaveProperty('stack')
  })

  it('无 fallbackMessage 时使用中文默认文案（不暴露英文原文）', () => {
    const payload = toErrorPayload(new Error('internal detail'), reqId())
    expect(payload.message).toBe('发生未预期的内部错误')
  })

  it('所有错误码归一化后仍是合法 Err 载荷', () => {
    for (const code of ERROR_CODES) {
      const payload = toErrorPayload(new ContractError({ code: code as ErrorCode, message: 'm', requestId: reqId() }), reqId())
      expect(isErrorCode(payload.code)).toBe(true)
      expect(typeof payload.retryable).toBe('boolean')
      expect(typeof payload.severity).toBe('string')
    }
  })
})
