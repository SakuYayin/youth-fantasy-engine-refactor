/**
 * 用例 `getSettingsEntity`：按 ID 读取一个设定实体。
 *
 * 授权范围只有一条：`context.workspaceId` 原样透传给端口。用例层**无法**自己比对
 * 实体的工作区——`SettingsEntity` 继承 `WorkspaceEntity` 却刻意没把 `workspaceId`
 * 暴露成可授权的字段（契约里它确实存在，但拿 payload 里的值做授权等于信任客户端）。
 * 所以跨工作区的判定必须在适配器里完成，并且必须返回 `PERMISSION_WORKSPACE_MISMATCH`
 * 而不是 `NOT_FOUND`：把越权伪装成「不存在」会让审计日志失去意义。
 */

import {
  errOf,
  type Result,
  type SettingsEntity,
  type SettingsEntityGetInput,
  type SettingsEntityGetOutput,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import { asRecord, requestIdOf, requireId, validateReadContext } from '../validate.js'

/**
 * 运行时形状门禁：端口返回的东西必须真的像一个设定实体。
 *
 * 🔴 不做这件事的代价是具体的：渲染层状态机拿到 `{ id: undefined }` 后会用
 *    `undefined` 去查表、去拼 IPC，错误会在离现场很远的地方爆出来。
 *    这里让它在边界上失败，并带上可检索的 TypeError。
 */
export function isSettingsEntityShape(value: unknown): value is SettingsEntity {
  const record = asRecord(value)
  if (record === null) return false
  const values = record['values']
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['projectId'] === 'string' &&
    record['projectId'].length > 0 &&
    typeof record['schemaTemplateId'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['orderKey'] === 'string' &&
    typeof record['revision'] === 'string' &&
    record['revision'].length > 0 &&
    typeof record['deleted'] === 'number' &&
    typeof values === 'object' &&
    values !== null &&
    !Array.isArray(values)
  )
}

export async function getSettingsEntity(
  deps: ApplicationDeps,
  input: SettingsEntityGetInput,
): Promise<Result<SettingsEntityGetOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '读取设定实体失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateReadContext(raw['context'])
    if (!context.ok) return context

    const entityId = requireId<string>(raw['entityId'], 'entityId', requestId)
    if (!entityId.ok) return entityId

    const found = await callPort(
      () =>
        deps.persistence.settingsEntities.getSettingsEntity({
          context: context.value,
          entityId: entityId.value,
        }),
      requestId,
      '读取设定实体失败',
    )
    if (!found.ok) return found

    if (!isSettingsEntityShape(found.value)) {
      return fail(
        new TypeError('getSettingsEntity 端口未返回设定实体形状'),
        requestId,
        '读取到的设定实体形状非法',
      )
    }
    return { ok: true, value: { entity: found.value } }
  })
}
