/**
 * 用例 `updateProject`：重命名作品。
 *
 * 授权范围是 `context.workspaceId`（作品的归属在工作区）。归属校验是**适配器的义务**
 * （`ports.ts`：适配器必须在工作区过滤后重查归属，防 TOCTOU）。
 *
 * `expectedRevision` 在 `context` 里（CAS 乐观锁由存储层执行）；
 * 同键幂等重放返回同一 `projectId` 与 `revision`（idempotency.ts）。
 */

import {
  errOf,
  type ProjectId,
  type ProjectUpdateInput,
  type ProjectUpdateOutput,
  type Result,
  type Revision,
} from '@yfe/contracts'

import { callPort, errFrom, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import type { ApplicationDeps } from '../ports.js'
import {
  MAX_PROJECT_NAME_LENGTH,
  asRecord,
  requestIdOf,
  requireId,
  requireText,
  validateWriteContext,
} from '../validate.js'

/** 幂等作用域：同键重放返回同一结果，不会二次改名。 */
export const UPDATE_PROJECT_SCOPE = 'updateProject'

export async function updateProject(
  deps: ApplicationDeps,
  input: ProjectUpdateInput,
): Promise<Result<ProjectUpdateOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '重命名作品失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const projectId = requireId<ProjectId>(raw['projectId'], 'projectId', requestId)
    if (!projectId.ok) return projectId

    const name = requireText(raw['name'], 'name', requestId, MAX_PROJECT_NAME_LENGTH)
    if (!name.ok) return name

    return withIdempotency<ProjectUpdateOutput>(
      deps.persistence.idempotency,
      UPDATE_PROJECT_SCOPE,
      context.value.idempotencyKey,
      requestId,
      async () => {
        const written = await callPort(
          () =>
            deps.persistence.projects.updateProject({
              context: context.value,
              projectId: projectId.value,
              name: name.value,
              // 时钟在用例层取，适配器不自己取时间
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '重命名作品失败',
        )
        if (!written.ok) return written

        const revision = asRecord(written.value)?.['revision']
        if (typeof revision !== 'string' || revision.length === 0) {
          const bad = errOf('INTERNAL_ERROR', '重命名作品结果缺少必要字段', requestId)
          return errFrom(bad.error, requestId)
        }
        return { ok: true, value: { projectId: projectId.value, revision: revision as Revision } }
      },
      JSON.stringify([context.value.workspaceId, projectId.value, name.value]),
    )
  })
}
