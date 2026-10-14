/**
 * 用例 `listDocumentTree`：取作品的文档树（平铺，不含正文）。
 *
 * 排序与层级不在这里计算：契约要求适配器按 `(parentId, orderKey)` 返回稳定顺序，
 * 应用层只负责授权范围（`context.workspaceId` → 端口）与 `includeDeleted` 归一。
 *
 * `includeDeleted` 默认 `false`：软删文档默认不进树。想显示「回收站」的场景
 * 必须显式传 `true`，避免误把 `-1` 之类的脏 `deleted` 值当成未删除而混入正常列表。
 */

import {
  errOf,
  type DocumentTreeInput,
  type DocumentSummary,
  type DocumentTreeOutput,
  type ProjectId,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import {
  asRecord,
  normalizeBoolean,
  requestIdOf,
  requireId,
  validateReadContext,
} from '../validate.js'

export async function listDocumentTree(
  deps: ApplicationDeps,
  input: DocumentTreeInput,
): Promise<Result<DocumentTreeOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '读取文档树失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateReadContext(raw['context'])
    if (!context.ok) return context

    const projectId = requireId<ProjectId>(raw['projectId'], 'projectId', requestId)
    if (!projectId.ok) return projectId

    const includeDeleted = normalizeBoolean(raw['includeDeleted'], false)

    const listed = await callPort(
      () =>
        deps.persistence.documents.listDocumentTree({
          context: context.value,
          projectId: projectId.value,
          includeDeleted,
        }),
      requestId,
      '读取文档树失败',
    )
    if (!listed.ok) return listed

    if (!Array.isArray(listed.value)) {
      return fail(
        new TypeError('listDocumentTree 端口未返回数组'),
        requestId,
        '读取到的文档树形状非法',
      )
    }
    const documents: readonly DocumentSummary[] = listed.value
    return { ok: true, value: { documents } }
  })
}
