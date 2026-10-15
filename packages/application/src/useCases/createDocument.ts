/**
 * 用例 `createDocument`：在作品内新建卷 / 章 / 大纲 / 笔记。
 *
 * 两条归属校验，各管一段：
 * 1. **用例层**：payload 里的 `projectId` 必须与 `context.projectId` 一致
 *    （不信任客户端自报；`context.projectId` 为 `null` 时无可比对，交由适配器判定）；
 * 2. **适配器**：`projectId` 归属 `context.workspaceId`、`parentId` 属于同一作品
 *    —— 这两件事需要读库，应用层拿不到他人实体的 `workspaceId`。
 *
 * `orderKey` 不在本层计算：它需要事务内读取同级相邻键（`@yfe/domain` 的
 * `orderKeyAfter` / `orderKeyBetween`），由适配器在事务内生成并回传。
 * `documentId` 由用例在幂等判定**之后**生成，重放既不写库也不消耗 ID。
 */

import {
  errOf,
  type DocumentCreateInput,
  type DocumentCreateOutput,
  type DocumentId,
  type ProjectId,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import type { ApplicationDeps } from '../ports.js'
import {
  MAX_TITLE_LENGTH,
  asRecord,
  requestIdOf,
  requireId,
  requireKind,
  requirePlacement,
  requireText,
  validateWriteContext,
} from '../validate.js'

/** 幂等作用域：同键重放返回同一个 `documentId`，不会建出重复章节。 */
export const CREATE_DOCUMENT_SCOPE = 'createDocument'

export async function createDocument(
  deps: ApplicationDeps,
  input: DocumentCreateInput,
): Promise<Result<DocumentCreateOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '创建文档失败', async () => {
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

    const kind = requireKind(raw['kind'], requestId)
    if (!kind.ok) return kind

    let parentId: DocumentId | null = null
    const rawParentId = raw['parentId']
    if (rawParentId !== null && rawParentId !== undefined) {
      const checked = requireId<DocumentId>(rawParentId, 'parentId', requestId)
      if (!checked.ok) return checked
      parentId = checked.value
    }

    const title = requireText(raw['title'], 'title', requestId, MAX_TITLE_LENGTH)
    if (!title.ok) return title

    const placement = requirePlacement(raw['placement'], requestId)
    if (!placement.ok) return placement

    const created = await withIdempotency<DocumentCreateOutput>(
      deps.persistence.idempotency,
      CREATE_DOCUMENT_SCOPE,
      context.value.idempotencyKey,
      requestId,
      async () => {
        // 🔴 ID 只在**真正要写库**时才生成（在幂等判定之后）：重放不该消耗一个 ID。
        const documentId: DocumentId = deps.ids.document()
        const written = await callPort(
          () =>
            deps.persistence.documents.createDocument({
              context: context.value,
              projectId: projectId.value,
              documentId,
              kind: kind.value,
              parentId,
              title: title.value,
              placement: placement.value,
              // 时钟由用例层注入：同一请求内的时间点只有一个来源
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '创建文档失败',
        )
        if (!written.ok) return written

        const record = asRecord(written.value)
        const revision = record?.['revision']
        const orderKey = record?.['orderKey']
        if (
          typeof revision !== 'string' ||
          revision.length === 0 ||
          typeof orderKey !== 'string' ||
          orderKey.length === 0
        ) {
          return fail(
            new TypeError('createDocument 端口未返回 revision/orderKey'),
            requestId,
            '创建文档结果缺少必要字段',
          )
        }
        // 🔴 幂等记录里必须**连 documentId 一起**缓存：否则重放会回一个从未落库的新 ID。
        return {
          ok: true,
          value: { documentId, revision: written.value.revision, orderKey: written.value.orderKey },
        }
      },
      JSON.stringify([context.value.workspaceId, projectId.value, kind.value, parentId,
        title.value, placement.value]),
    )
    return created
  })
}
