/**
 * main 侧响应信封的校验（形状见 `apps/desktop/src/preload/ipc-methods.d.cts:5-23`
 * 与 `apps/desktop/src/shared/ipc/protocol.ts`）。
 *
 *   成功: { kind:'response', requestId, ok:true,  method, value }
 *   失败: { kind:'response', requestId, ok:false, method, error:{ code, message, … } }
 *
 * 铁律：**绝不把畸形当成功**。任何一处对不上都是 `INTERNAL_ERROR`，
 * 判定依据放进 `detail.reason`（机器可读），而不是塞进 `message` 污染用户文案。
 */
import { err, ok, type Result } from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'
import { clientError, sanitizeErrorPayload } from './errors.js'
import type { IpcMethod } from './whitelist.js'

/** 畸形判定的机器可读原因（稳定字符串，测试逐条断言）。 */
export type EnvelopeMalformedReason =
  | 'envelope_not_object'
  | 'kind_not_response'
  | 'ok_not_boolean'
  | 'method_mismatch'
  | 'missing_value'
  | 'missing_error'
  | 'missing_error_code'

/** 畸形信封的对外文案（可展示，不含内部细节）。 */
export const MALFORMED_MESSAGE = 'IPC 响应畸形，已拒绝采用'

function malformed(
  reason: EnvelopeMalformedReason,
  method: IpcMethod,
  requestId: RequestId,
  extra?: Readonly<Record<string, string>>,
): Result<never> {
  return err(
    clientError('INTERNAL_ERROR', MALFORMED_MESSAGE, requestId, {
      reason,
      method,
      ...(extra ?? {}),
    }),
  )
}

/**
 * 校验并把响应信封折算成 `Result<T>`。
 *
 * @param raw        transport 回来的任意值（不可信）
 * @param method     本次请求的方法名，用于**串号检测**
 * @param requestId  本地请求 ID，用于兜底关联
 */
export function parseResponseEnvelope<T = unknown>(
  raw: unknown,
  method: IpcMethod,
  requestId: RequestId,
): Result<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return malformed('envelope_not_object', method, requestId)
  }
  const envelope = raw as Record<string, unknown>

  if (envelope['kind'] !== 'response') {
    return malformed('kind_not_response', method, requestId)
  }
  if (typeof envelope['ok'] !== 'boolean') {
    return malformed('ok_not_boolean', method, requestId)
  }

  // 串号检测：main 按 requestId 去重，允许并发在飞；回包的方法必须与请求一致，
  // 否则就是渠道串号/信封错配，宁可失败也不能把别人的结果当成自己的。
  if (envelope['method'] !== method) {
    const envelopeType = envelope['method'] === null ? 'null' : typeof envelope['method']
    return malformed('method_mismatch', method, requestId, { envelopeMethodType: envelopeType })
  }

  if (envelope['ok'] === true) {
    // `value: undefined` 与「没有 value」等价（JSON 表达不了 undefined）：
    // 出现即说明信封被截断或伪造，不能当成合法值。注意 0 / '' / false / null 都是合法值。
    if (!('value' in envelope) || envelope['value'] === undefined) {
      return malformed('missing_value', method, requestId)
    }
    return ok(envelope['value'] as T)
  }

  const rawError = envelope['error']
  if (typeof rawError !== 'object' || rawError === null || Array.isArray(rawError)) {
    return malformed('missing_error', method, requestId)
  }
  const rawCode = (rawError as Record<string, unknown>)['code']
  if (typeof rawCode !== 'string' || rawCode === '') {
    return malformed('missing_error_code', method, requestId)
  }

  // 失败信封逐字段脱敏后透传；未知码由 sanitizeErrorPayload 折算成 INTERNAL_ERROR。
  return err(sanitizeErrorPayload(rawError, requestId))
}
