/**
 * 宿主侧错误映射（`@yfe/plugin-host/host` 内部使用）。
 *
 * 🔴 **契约不允许宿主自造错误码**（`packages/contracts` 已冻结）。task-4 里提到的
 * 「`PLUGIN_DEPENDENCY_MISSING` 类错误」在契约中**不存在**，因此本模块把宿主语义
 * 映射到已有 `PLUGIN_*` 码，并用 `detail.reason` 区分同码不同因：
 *
 * | 宿主语义 | ErrorCode | detail.reason |
 * | --- | --- | --- |
 * | 未知插件 id | `PLUGIN_NOT_FOUND` | — |
 * | manifest 非法 / 不受信来源 | `PLUGIN_MANIFEST_INVALID` | `manifest-invalid` / `not-trusted-builtin` |
 * | 依赖缺失 | `PLUGIN_MANIFEST_INVALID` | `dependency-missing` |
 * | 依赖循环 | `PLUGIN_MANIFEST_INVALID` | `dependency-cycle` |
 * | 依赖版本不满足 | `PLUGIN_API_INCOMPATIBLE` | `dependency-version-mismatch` |
 * | 宿主 API 版本不兼容 | `PLUGIN_API_INCOMPATIBLE` | `host-api-incompatible` |
 * | 激活抛错 | `PLUGIN_ACTIVATION_FAILED` | `activation-threw` |
 * | 清理超时（进入 quarantined） | `PLUGIN_ACTIVATION_FAILED` | `cleanup-timeout` |
 * | 已禁用插件被调用 | `PLUGIN_DISABLED` | — |
 * | 能力未声明/未授权 | `PERMISSION_PLUGIN_CAPABILITY` | — |
 * | 依赖未激活就加载目标 | `PLUGIN_ACTIVATION_FAILED` | `dependency-not-active` |
 *
 * 🔴 `detail` 只允许 `string | number | boolean | null`，且**禁止**正文、密钥、
 * 绝对路径中的用户名（契约硬约束）。因此这里只放码值、计数与插件 id。
 */

import { ContractError, isRetryable, severityOf } from '@yfe/contracts'
import type { ErrorCode, ErrorPayload, RequestId } from '@yfe/contracts'

type Detail = Readonly<Record<string, string | number | boolean | null>>

/** 构造 ErrorPayload；severity/retryable 一律由契约的映射函数推导，不手写。 */
export function makePayload(
  code: ErrorCode,
  message: string,
  requestId: RequestId,
  detail?: Detail,
): ErrorPayload {
  return {
    code,
    message,
    requestId,
    severity: severityOf(code),
    retryable: isRetryable(code),
    ...(detail === undefined ? {} : { detail }),
  }
}

/** 把 ErrorPayload 包成可抛出的 ContractError（宿主内部流程中断用）。 */
export function throwPayload(payload: ErrorPayload): never {
  throw new ContractError({ ...payload })
}

// ---------------------------------------------------------------------------
// 逐语义的构造器：调用点只表达「发生了什么事」，不关心码表
// ---------------------------------------------------------------------------

export function notFoundPayload(pluginId: string, requestId: RequestId): ErrorPayload {
  return makePayload('PLUGIN_NOT_FOUND', `插件未注册或未加载：${pluginId}`, requestId, {
    pluginId,
  })
}

/**
 * 插件要解析的宿主服务不存在。
 *
 * 🔴 刻意**不**复用 `notFoundPayload`（那是 `PLUGIN_NOT_FOUND`，语义是「插件未注册」）：
 * 把缺服务报成缺插件会让插件作者排查到完全错误的方向。
 */
export function serviceNotFoundPayload(service: string, requestId: RequestId): ErrorPayload {
  return makePayload('NOT_FOUND', `宿主未提供插件服务：${service}`, requestId, { service })
}

export function notTrustedPayload(pluginId: string, requestId: RequestId): ErrorPayload {
  return makePayload(
    'PLUGIN_MANIFEST_INVALID',
    `插件 ${pluginId} 不在宿主发行清单中，本版本只加载可信内置插件（见 ADR 008）`,
    requestId,
    { pluginId, reason: 'not-trusted-builtin' },
  )
}

export function manifestInvalidPayload(
  pluginId: string,
  requestId: RequestId,
  detail: Detail,
): ErrorPayload {
  return makePayload('PLUGIN_MANIFEST_INVALID', `插件 ${pluginId} 的 manifest 校验失败`, requestId, {
    pluginId,
    ...detail,
  })
}

export function dependencyMissingPayload(
  pluginId: string,
  missingId: string,
  requestId: RequestId,
): ErrorPayload {
  return makePayload(
    'PLUGIN_MANIFEST_INVALID',
    `插件 ${pluginId} 缺少依赖 ${missingId}`,
    requestId,
    { pluginId, reason: 'dependency-missing', missing: missingId },
  )
}

export function dependencyCyclePayload(
  pluginId: string,
  cycle: readonly string[],
  requestId: RequestId,
): ErrorPayload {
  return makePayload(
    'PLUGIN_MANIFEST_INVALID',
    `插件 ${pluginId} 的依赖存在循环：${cycle.join(' -> ')}`,
    requestId,
    { pluginId, reason: 'dependency-cycle', cycle: cycle.join(' -> ') },
  )
}

export function dependencyVersionPayload(
  pluginId: string,
  dependencyId: string,
  required: string,
  found: string,
  requestId: RequestId,
): ErrorPayload {
  return makePayload(
    'PLUGIN_API_INCOMPATIBLE',
    `插件 ${pluginId} 要求依赖 ${dependencyId}@${required}，实际为 ${found}`,
    requestId,
    { pluginId, reason: 'dependency-version-mismatch', dependencyId, required, found },
  )
}

export function hostApiIncompatiblePayload(
  pluginId: string,
  required: string,
  hostApiVersion: string,
  requestId: RequestId,
): ErrorPayload {
  return makePayload(
    'PLUGIN_API_INCOMPATIBLE',
    `插件 ${pluginId} 要求宿主 API ${required}，当前宿主 API 为 ${hostApiVersion}`,
    requestId,
    { pluginId, reason: 'host-api-incompatible', required, hostApiVersion },
  )
}

export function activationFailedPayload(
  pluginId: string,
  reason:
    | 'activation-threw'
    | 'cleanup-timeout'
    | 'dependency-not-active'
    | 'required-service-missing'
    | 'cleanup-failed',
  message: string,
  requestId: RequestId,
  detail?: Detail,
): ErrorPayload {
  return makePayload('PLUGIN_ACTIVATION_FAILED', message, requestId, {
    pluginId,
    reason,
    ...detail,
  })
}

export function disabledPayload(pluginId: string, requestId: RequestId): ErrorPayload {
  return makePayload('PLUGIN_DISABLED', `插件 ${pluginId} 已被禁用`, requestId, { pluginId })
}
