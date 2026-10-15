/**
 * 用例 `saveSettingsEntity`：新建设定实体，或按乐观锁更新既有实体。
 *
 * 一条命令两种语义，靠 `entityId` 区分（缺省/`null` = 新建）。这么设计是因为
 * 通用表单页签的「保存」按钮**只有一个**：先读、改、再存，用户不关心底层是 INSERT
 * 还是 UPDATE；把它拆成两条命令会迫使每个界面自己判断该调哪条，判断错了就会
 * 用更新的语义去新建（或反过来，把新建的 ID 覆盖到别人身上）。
 *
 * 四条不变量：
 * 1. **新建**要求 `context.expectedRevision === null`（没有「期望的旧版本」可谈）；
 *    更新则由存储层比对 `expectedRevision`，过期返回 `REVISION_CONFLICT`。
 * 2. **`values` 是整体替换**，不是深合并。契约里 `values` 是必填对象，
 *    所以「只改名字」也要把完整字段集传上来——否则字段会被空对象覆盖掉。
 *    这不是疏漏而是刻意：深合并无法表达「删掉一个字段」，而模板字段是可增可减的。
 * 3. **ID 在幂等判定之后才生成**：重放不消耗新 ID，且「返回给调用方的 ID」与
 *    「落库的 ID」必然同源（与 `createProject` / `createDocument` 同规矩）。
 * 4. **不信任 payload 的作品声明**：`projectId` 必须与 `context.projectId` 一致。
 */

import {
  errOf,
  type ProjectId,
  type Result,
  type SettingsEntitySaveInput,
  type SettingsEntitySaveOutput,
} from '@yfe/contracts'

import { badField } from '../validate.js'
import { callPort, errFrom, fail, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import type { ApplicationDeps } from '../ports.js'
import {
  MAX_ENTITY_NAME_LENGTH,
  MAX_ORDER_KEY_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  asRecord,
  requestIdOf,
  requireId,
  requireText,
  requireValuesRecord,
  validateWriteContext,
} from '../validate.js'

/** 幂等作用域：同键重放返回同一个 `entityId`，不会建出重复设定。 */
export const SAVE_SETTINGS_ENTITY_SCOPE = 'saveSettingsEntity'

/**
 * 请求身份：同键但入参不同 = 客户端复用了幂等键。
 *
 * 单独包一层 try/catch 是因为 `values` 里可能有循环引用，`JSON.stringify` 会抛。
 * 那种输入该由**存储层**判成 `VALIDATION_FAILED`，不能在这里变成一个
 * 无从解释的 `INTERNAL_ERROR`；算不出身份就退化成「不比身份」而不是报错。
 */
function requestIdentityOf(parts: readonly unknown[]): string | undefined {
  try {
    return JSON.stringify(parts)
  } catch {
    return undefined
  }
}

export async function saveSettingsEntity(
  deps: ApplicationDeps,
  input: SettingsEntitySaveInput,
): Promise<Result<SettingsEntitySaveOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '保存设定实体失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const projectId = requireId<ProjectId>(raw['projectId'], 'projectId', requestId)
    if (!projectId.ok) return projectId

    // 不信任 payload：payload 声明的作品必须与 context 声明的作品一致
    const declared = context.value.projectId
    if (declared !== null && declared !== projectId.value) {
      const mismatch = errOf(
        'PERMISSION_WORKSPACE_MISMATCH',
        'projectId 与 context 声明的作品不一致',
        requestId,
        { field: 'projectId' },
      )
      return errFrom(mismatch.error, requestId)
    }

    const schemaTemplateId = requireText(
      raw['schemaTemplateId'],
      'schemaTemplateId',
      requestId,
      MAX_TEMPLATE_ID_LENGTH,
    )
    if (!schemaTemplateId.ok) return schemaTemplateId

    const name = requireText(raw['name'], 'name', requestId, MAX_ENTITY_NAME_LENGTH)
    if (!name.ok) return name

    const values = requireValuesRecord(raw['values'], 'values', requestId)
    if (!values.ok) return values

    let entityId: string | null = null
    const rawEntityId = raw['entityId']
    if (rawEntityId !== null && rawEntityId !== undefined) {
      const checked = requireId<string>(rawEntityId, 'entityId', requestId)
      if (!checked.ok) return checked
      entityId = checked.value
    }
    const isCreate = entityId === null

    if (isCreate && context.value.expectedRevision !== null) {
      return badField(
        'context.expectedRevision',
        requestId,
        '新建设定实体时 expectedRevision 必须为 null（更新才用乐观锁）',
      )
    }

    let orderKey: string | null = null
    const rawOrderKey = raw['orderKey']
    if (rawOrderKey !== null && rawOrderKey !== undefined) {
      const checked = requireText(rawOrderKey, 'orderKey', requestId, MAX_ORDER_KEY_LENGTH)
      if (!checked.ok) return checked
      orderKey = checked.value
    }

    return withIdempotency<SettingsEntitySaveOutput>(
      deps.persistence.idempotency,
      SAVE_SETTINGS_ENTITY_SCOPE,
      context.value.idempotencyKey,
      requestId,
      async () => {
        // 🔴 ID 只在真正要写库时生成：重放既不写库也不消耗 ID。
        const targetId = entityId ?? deps.ids.settingsEntity()
        const written = await callPort(
          () =>
            deps.persistence.settingsEntities.saveSettingsEntity({
              context: context.value,
              entityId: targetId,
              isCreate,
              projectId: projectId.value,
              schemaTemplateId: schemaTemplateId.value,
              name: name.value,
              values: values.value,
              orderKey,
              // 时钟由用例层注入：同一请求内的时间点只有一个来源
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '保存设定实体失败',
        )
        if (!written.ok) return written

        const record = asRecord(written.value)
        const revision = record?.['revision']
        const returnedId = record?.['entityId']
        const returnedOrderKey = record?.['orderKey']
        if (
          typeof revision !== 'string' ||
          revision.length === 0 ||
          typeof returnedId !== 'string' ||
          returnedId.length === 0 ||
          typeof returnedOrderKey !== 'string' ||
          returnedOrderKey.length === 0
        ) {
          return fail(
            new TypeError('saveSettingsEntity 端口未返回 entityId/revision/orderKey'),
            requestId,
            '保存设定实体结果缺少必要字段',
          )
        }
        return {
          ok: true,
          value: {
            entityId: returnedId,
            revision: revision as SettingsEntitySaveOutput['revision'],
            orderKey: returnedOrderKey,
          },
        }
      },
      requestIdentityOf([
        context.value.workspaceId,
        projectId.value,
        entityId,
        schemaTemplateId.value,
        name.value,
        values.value,
        orderKey,
      ]),
    )
  })
}
