/**
 * 用例 `listSettingsEntities`：列出设定实体（作品级或工作区级）。
 *
 * 这个用例是 29 个数据驱动旧页签（5 form / 6 card / 18 table）共用的读入口：
 * 它们读的都是同一张 `settings_entities`，差异只在 `schemaTemplateId` 指向的模板。
 *
 * 两个可选字段在**本层**就归一成 `null`/布尔，端口因此不必区分「没传」与 `undefined`：
 * - `projectId` 缺省 → `null` = 工作区级列表（跨作品，例如全局检索/回收站）；
 * - `schemaTemplateId` 缺省 → `null` = 不按模板过滤。
 *
 * ⚠️ 与文档树不同，`includeDeleted` 默认 `false` 的理由一样：软删实体默认不可见，
 *    回收站视图必须显式要。取消删除的功能本期不做。
 */

import {
  errOf,
  type ProjectId,
  type Result,
  type SettingsEntity,
  type SettingsEntityListInput,
  type SettingsEntityListOutput,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import {
  MAX_TEMPLATE_ID_LENGTH,
  asRecord,
  normalizeBoolean,
  requestIdOf,
  requireId,
  requireText,
  validateReadContext,
} from '../validate.js'
import { isSettingsEntityShape } from './getSettingsEntity.js'

export async function listSettingsEntities(
  deps: ApplicationDeps,
  input: SettingsEntityListInput,
): Promise<Result<SettingsEntityListOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '列出设定实体失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateReadContext(raw['context'])
    if (!context.ok) return context

    // `projectId` 是可选的，但**一旦给出就必须合法**：把 `42` 当成「没传」会静默
    // 变成跨作品查询，那是「读到比要求更多的数据」，比报错更危险。
    let projectId: ProjectId | null = null
    const rawProjectId = raw['projectId']
    if (rawProjectId !== null && rawProjectId !== undefined) {
      const checked = requireId<ProjectId>(rawProjectId, 'projectId', requestId)
      if (!checked.ok) return checked
      projectId = checked.value
    }

    let schemaTemplateId: string | null = null
    const rawTemplateId = raw['schemaTemplateId']
    if (rawTemplateId !== null && rawTemplateId !== undefined) {
      const checked = requireText(rawTemplateId, 'schemaTemplateId', requestId, MAX_TEMPLATE_ID_LENGTH)
      if (!checked.ok) return checked
      schemaTemplateId = checked.value
    }

    const includeDeleted = normalizeBoolean(raw['includeDeleted'], false)

    const listed = await callPort(
      () =>
        deps.persistence.settingsEntities.listSettingsEntities({
          context: context.value,
          projectId,
          schemaTemplateId,
          includeDeleted,
        }),
      requestId,
      '列出设定实体失败',
    )
    if (!listed.ok) return listed

    if (!Array.isArray(listed.value)) {
      return fail(
        new TypeError('listSettingsEntities 端口未返回数组'),
        requestId,
        '读取到的设定实体列表形状非法',
      )
    }
    for (const entity of listed.value) {
      if (!isSettingsEntityShape(entity)) {
        return fail(
          new TypeError('listSettingsEntities 端口返回了非设定实体元素'),
          requestId,
          '读取到的设定实体列表形状非法',
        )
      }
    }

    const entities: readonly SettingsEntity[] = listed.value
    return { ok: true, value: { entities } }
  })
}
