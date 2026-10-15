/**
 * 用例 `deleteProject`：软删作品。
 *
 * 授权范围是 `context.workspaceId`。归属校验是**适配器的义务**。
 *
 * 🔴 只标记作品行，**不级联**子文档（与真实存储层一致：可见性由作品决定）；
 *    重复删除报 `NOT_FOUND_PROJECT`。
 * `expectedRevision` 在 `context` 里；同键幂等重放返回同一结果（idempotency.ts）。
 */

import {
  errOf,
  type ProjectDeleteInput,
  type ProjectDeleteOutput,
  type ProjectId,
  type Result,
  type Revision,
} from '@yfe/contracts'

import { callPort, errFrom, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import type { ApplicationDeps } from '../ports.js'
import { asRecord, requestIdOf, requireId, validateWriteContext } from '../validate.js'

/** 幂等作用域：同键重放返回同一结果。 */
export const DELETE_PROJECT_SCOPE = 'deleteProject'

export async function deleteProject(
  deps: ApplicationDeps,
  input: ProjectDeleteInput,
): Promise<Result<ProjectDeleteOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '删除作品失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const projectId = requireId<ProjectId>(raw['projectId'], 'projectId', requestId)
    if (!projectId.ok) return projectId

    return withIdempotency<ProjectDeleteOutput>(
      deps.persistence.idempotency,
      DELETE_PROJECT_SCOPE,
      context.value.idempotencyKey,
      requestId,
      async () => {
        const written = await callPort(
          () =>
            deps.persistence.projects.deleteProject({
              context: context.value,
              projectId: projectId.value,
              // 时钟在用例层取，适配器不自己取时间
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '删除作品失败',
        )
        if (!written.ok) return written

        const record = asRecord(written.value)
        const revision = record?.['revision']
        if (typeof revision !== 'string' || revision.length === 0) {
          const bad = errOf('INTERNAL_ERROR', '删除作品结果缺少必要字段', requestId)
          return errFrom(bad.error, requestId)
        }
        return { ok: true, value: { projectId: projectId.value, revision: revision as Revision } }
      },
      JSON.stringify([context.value.workspaceId, projectId.value]),
    )
  })
}
