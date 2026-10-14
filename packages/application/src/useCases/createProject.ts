/**
 * 用例 `createProject`：新建作品。
 *
 * 授权范围是 `context.workspaceId`（作品归属于工作区，而作品本身还不存在，
 * **没有任何 payload 归属可校验**）。`context.projectId` 在本用例中不参与判定：
 * 它描述的是调用方「当前所在作品」，与「正在创建的新作品」无关
 * （契约未定义该语义，已在交付报告的「契约缺口」里上报）。
 *
 * ID 由 {@link ApplicationDeps.ids} 生成并**先于端口调用**产生，因此
 * 「返回给调用方的 projectId」与「适配器落库的 projectId」必然同一个。
 * ID 在幂等判定**之后**才生成：同键重放既不写库、也不消耗 ID。
 */

import {
  errOf,
  type ProjectId,
  type ProjectCreateInput,
  type ProjectCreateOutput,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import type { ApplicationDeps } from '../ports.js'
import {
  MAX_PROJECT_NAME_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  asRecord,
  normalizeBoolean,
  normalizeOptionalText,
  requestIdOf,
  requireText,
  validateWriteContext,
} from '../validate.js'

/** 幂等作用域：同键重放返回同一个 `projectId`，不会建出第二个作品。 */
export const CREATE_PROJECT_SCOPE = 'createProject'

export async function createProject(
  deps: ApplicationDeps,
  input: ProjectCreateInput,
): Promise<Result<ProjectCreateOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '创建作品失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const name = requireText(raw['name'], 'name', requestId, MAX_PROJECT_NAME_LENGTH)
    if (!name.ok) return name

    const summary = normalizeOptionalText(raw['summary'], MAX_SUMMARY_LENGTH)
    const seedFirstChapter = normalizeBoolean(raw['seedFirstChapter'], false)

    let templateId: string | null = null
    const rawTemplateId = raw['templateId']
    if (rawTemplateId !== null && rawTemplateId !== undefined) {
      const checked = requireText(rawTemplateId, 'templateId', requestId, MAX_TEMPLATE_ID_LENGTH)
      if (!checked.ok) return checked
      templateId = checked.value
    }

    const created = await withIdempotency<ProjectCreateOutput>(
      deps.persistence.idempotency,
      CREATE_PROJECT_SCOPE,
      context.value.idempotencyKey,
      requestId,
      async () => {
        // 🔴 ID 只在**真正要写库**时才生成（在幂等判定之后）：重放不该消耗一个 ID。
        const projectId: ProjectId = deps.ids.project()
        const written = await callPort(
          () =>
            deps.persistence.projects.createProject({
              context: context.value,
              projectId,
              name: name.value,
              summary,
              seedFirstChapter,
              templateId,
              // 时钟与 ID 都在用例层取，适配器不自己取时间
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '创建作品失败',
        )
        if (!written.ok) return written

        const revision = asRecord(written.value)?.['revision']
        if (typeof revision !== 'string' || revision.length === 0) {
          return fail(
            new TypeError('createProject 端口未返回 revision'),
            requestId,
            '创建作品结果缺少必要字段',
          )
        }
        // 🔴 幂等记录里必须**连 projectId 一起**缓存：否则重放会回一个从未落库的新 ID。
        return { ok: true, value: { projectId, revision: written.value.revision } }
      },
    )
    return created
  })
}
