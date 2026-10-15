/**
 * 用例 `deleteDocument`：软删一篇文档，默认**级联删掉整棵子树**。
 *
 * 软删（`deleted` 标记）而不是物理删：回收站视图与同步墓碑都依赖它
 * （设计文档 07：删除用基线生成墓碑）。级联删除也是「这些实体变了」，
 * 版本号逐行推进由存储层负责（`softDeleteDocument`）。工作区归属与
 * `expectedRevision` 乐观锁同样在存储层复查。
 */

import {
  errOf,
  type DocumentDeleteInput,
  type DocumentDeleteOutput,
  type DocumentId,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import { asRecord, requestIdOf, requireId, validateWriteContext } from '../validate.js'

export async function deleteDocument(
  deps: ApplicationDeps,
  input: DocumentDeleteInput,
): Promise<Result<DocumentDeleteOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '删除文档失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const documentId = requireId<DocumentId>(raw['documentId'], 'documentId', requestId)
    if (!documentId.ok) return documentId

    const deleted = await callPort(
      () =>
        deps.persistence.documents.deleteDocument({
          context: context.value,
          documentId: documentId.value,
        }),
      requestId,
      '删除文档失败',
    )
    if (!deleted.ok) return deleted

    // 形状门禁：revision 与 deletedCount 都必须存在。
    const record = asRecord(deleted.value)
    if (
      record === null ||
      typeof record['revision'] !== 'string' ||
      typeof record['deletedCount'] !== 'number'
    ) {
      return fail(
        new TypeError('deleteDocument 端口返回了不符合 DeleteDocumentResult 形状的值'),
        requestId,
        '文档删除结果形状非法',
      )
    }
    return {
      ok: true,
      value: { revision: deleted.value.revision, deletedCount: deleted.value.deletedCount },
    }
  })
}
