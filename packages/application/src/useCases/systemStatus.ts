/**
 * 用例 `systemStatus`：组装设置页/诊断页要的 `SystemStatusOutput`。
 *
 * 分工：**协议版本号不是宿主的事实**，它们来自 `@yfe/contracts`
 * （`SYNC_PROTOCOL_VERSION`、`PLUGIN_API_VERSION`），由本用例直接取；
 * 只有「实际打开的库」「宿主版本」「待同步条数」这类运行时事实才走
 * {@link SystemStatusPort}。这样各宿主不会各自硬编码一份版本号而漂移。
 *
 * `context` 是可选的：状态查询本身不需要工作区（CLI 诊断、登录前探活都要能调）。
 * 传了就照样校验形状；不传时错误载荷的 `requestId` 用稳定占位符
 * `req-unknown`（本包禁止随机生成，占位符可被检索定位）。
 */

import {
  PLUGIN_API_VERSION,
  SYNC_PROTOCOL_VERSION,
  errOf,
  type ReadContext,
  type RequestId,
  type Result,
  type SystemStatusOutput,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps, SystemStatusFacts } from '../ports.js'
import { UNKNOWN_REQUEST_ID, asRecord, validateReadContext } from '../validate.js'

export async function systemStatus(
  deps: ApplicationDeps,
  context?: ReadContext,
): Promise<Result<SystemStatusOutput>> {
  let requestId: RequestId = UNKNOWN_REQUEST_ID
  if (context !== undefined) {
    const checked = validateReadContext(context)
    if (!checked.ok) return checked
    requestId = checked.value.requestId
  }

  return guard<SystemStatusOutput>(requestId, '读取系统状态失败', async () => {
    const facts = await callPort(
      () => deps.persistence.system.readSystemStatus(),
      requestId,
      '读取系统状态失败',
    )
    if (!facts.ok) return facts

    const invalid = validateFacts(facts.value, requestId)
    if (invalid !== null) return invalid

    const output: SystemStatusOutput = {
      appVersion: facts.value.appVersion,
      databaseSchemaVersion: facts.value.databaseSchemaVersion,
      syncProtocolVersion: {
        major: SYNC_PROTOCOL_VERSION.major,
        minor: SYNC_PROTOCOL_VERSION.minor,
      },
      pluginApiVersion: PLUGIN_API_VERSION,
      resourceTemplateVersion: facts.value.resourceTemplateVersion,
      databasePath: facts.value.databasePath,
      readOnly: facts.value.readOnly,
      lastSavedAt: facts.value.lastSavedAt,
      pendingOutboxCount: facts.value.pendingOutboxCount,
    }
    return { ok: true, value: output }
  })
}

/** 运行时事实的形状门禁：字段缺失/类型不符一律 `INTERNAL_ERROR`，不伪造默认值。 */
function validateFacts(facts: SystemStatusFacts, requestId: RequestId): Result<never> | null {
  const record = asRecord(facts)
  if (record === null) {
    return fail(new TypeError('readSystemStatus 返回非对象'), requestId, '读取到的系统状态形状非法')
  }
  const appVersion = record['appVersion']
  const databaseSchemaVersion = record['databaseSchemaVersion']
  const databasePath = record['databasePath']
  const readOnly = record['readOnly']
  const lastSavedAt = record['lastSavedAt']
  const pendingOutboxCount = record['pendingOutboxCount']
  const resourceTemplateVersion = record['resourceTemplateVersion']

  const bad =
    typeof appVersion !== 'string' ||
    appVersion.length === 0 ||
    typeof databaseSchemaVersion !== 'number' ||
    !Number.isSafeInteger(databaseSchemaVersion) ||
    typeof databasePath !== 'string' ||
    typeof readOnly !== 'boolean' ||
    typeof pendingOutboxCount !== 'number' ||
    !Number.isSafeInteger(pendingOutboxCount) ||
    pendingOutboxCount < 0 ||
    (lastSavedAt !== null && (typeof lastSavedAt !== 'string' || lastSavedAt.length === 0)) ||
    (resourceTemplateVersion !== null &&
      (typeof resourceTemplateVersion !== 'string' || resourceTemplateVersion.length === 0))
  if (!bad) return null

  const malformed = errOf('INTERNAL_ERROR', '系统状态缺少必要字段或类型不符', requestId, {
    field: 'SystemStatusFacts',
  })
  return errFrom(malformed.error, requestId)
}
