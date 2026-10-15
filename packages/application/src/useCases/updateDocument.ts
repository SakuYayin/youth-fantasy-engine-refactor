/**
 * 用例 `updateDocument`：重命名与/或重排一篇文档。
 *
 * 两个可选字段（`title` / `placement`）**都不给** → `VALIDATION_FAILED`：
 * 空操作没有意义，静默成功会让调用方误以为改过了。传了空标题也报错
 * （改名不能改成空）。工作区归属与 `expectedRevision` 乐观锁是适配器的
 * 义务（存储层 `loadDocumentForWrite` 复查）；`placement.afterId === documentId`
 * 同样由存储层拒绝（不能把文档排到它自己之后）。
 */

import {
  errOf,
  type DocumentId,
  type DocumentUpdateInput,
  type DocumentUpdateOutput,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps, UpdateDocumentRequest } from '../ports.js'
import {
  MAX_TITLE_LENGTH,
  asRecord,
  requestIdOf,
  requireId,
  requirePlacement,
  requireText,
  validateWriteContext,
} from '../validate.js'

export async function updateDocument(
  deps: ApplicationDeps,
  input: DocumentUpdateInput,
): Promise<Result<DocumentUpdateOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '更新文档失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const documentId = requireId<DocumentId>(raw['documentId'], 'documentId', requestId)
    if (!documentId.ok) return documentId

    // 可选字段归一：没传就是不动那一项。传了空标题 → 报错（改名不能改成空）。
    let title: string | undefined
    if (raw['title'] !== undefined) {
      const titleResult = requireText(raw['title'], 'title', requestId, MAX_TITLE_LENGTH)
      if (!titleResult.ok) return titleResult
      title = titleResult.value
    }
    let placement: UpdateDocumentRequest['placement'] | undefined
    if (raw['placement'] !== undefined) {
      const placementResult = requirePlacement(raw['placement'], requestId)
      if (!placementResult.ok) return placementResult
      placement = placementResult.value
    }
    if (title === undefined && placement === undefined) {
      return errOf('VALIDATION_FAILED', '没有要修改的内容：title 与 placement 至少给一个', requestId, {
        field: 'title',
      })
    }

    const written = await callPort(
      () =>
        deps.persistence.documents.updateDocument({
          context: context.value,
          documentId: documentId.value,
          ...(title === undefined ? {} : { title }),
          ...(placement === undefined ? {} : { placement }),
        }),
      requestId,
      '更新文档失败',
    )
    if (!written.ok) return written

    // 形状门禁：revision 必须存在；orderKey 只在重排时由适配器回传。
    const record = asRecord(written.value)
    if (record === null || typeof record['revision'] !== 'string') {
      return fail(
        new TypeError('updateDocument 端口返回了不符合 UpdateDocumentResult 形状的值'),
        requestId,
        '文档更新结果形状非法',
      )
    }
    const orderKey = typeof record['orderKey'] === 'string' ? record['orderKey'] : undefined
    return {
      ok: true,
      value: {
        revision: written.value.revision,
        ...(orderKey === undefined ? {} : { orderKey }),
      },
    }
  })
}
