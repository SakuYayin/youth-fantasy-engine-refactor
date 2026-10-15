/**
 * 用例 `listProjects`：列出工作区内的作品。
 *
 * 授权范围是 `context.workspaceId`（读端口自行按工作区过滤——跨工作区泄漏是
 * 安全缺陷，不是风格问题；见 `ports.ts` 只读端口约束 3）。
 *
 * 排序与内容都是适配器的职责（契约输出是 `Project[]`，正文与工作区 ID 不外泄）。
 */

import {
  errOf,
  type Project,
  type ProjectListInput,
  type ProjectListOutput,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import { asRecord, requestIdOf, validateReadContext } from '../validate.js'

export async function listProjects(
  deps: ApplicationDeps,
  input: ProjectListInput,
): Promise<Result<ProjectListOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '列出作品失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateReadContext(raw['context'])
    if (!context.ok) return context

    const listed = await callPort(
      () =>
        deps.persistence.projects.listProjects({
          context: context.value,
          includeDeleted: false,
        }),
      requestId,
      '列出作品失败',
    )
    if (!listed.ok) return listed

    const projects = listed.value
    if (!Array.isArray(projects)) {
      return failShape(requestId)
    }
    for (const row of projects) {
      const record = asRecord(row)
      if (record === null || typeof record?.['id'] !== 'string' || typeof record?.['name'] !== 'string') {
        return failShape(requestId)
      }
    }
    return { ok: true, value: { projects } }
  })
}

function failShape(requestId: ReturnType<typeof requestIdOf>) {
  const bad = errOf('INTERNAL_ERROR', '列出作品结果缺少必要字段', requestId)
  return errFrom(bad.error, requestId)
}
