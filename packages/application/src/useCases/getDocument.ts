/**
 * 用例 `getDocument`：按 ID 取单篇文档（摘要 + 正文）。
 *
 * 只做三件事：校验 `ReadContext` 与 `documentId`、调端口、把「不存在」翻译成契约错误码。
 * 工作区过滤是**适配器的义务**（`DocumentSummary` 契约里没有 `workspaceId`，
 * 应用层无法复查，所以端口必须在 SQL 层就按 `context.workspaceId` 过滤）。
 */

import {
  errOf,
  type DocumentGetInput,
  type DocumentGetOutput,
  type DocumentId,
  type RequestId,
  type Result,
} from '@yfe/contracts'

import { callPort, errFrom, fail, guard } from '../errors.js'
import type { ApplicationDeps } from '../ports.js'
import { asRecord, requestIdOf, requireId, validateReadContext } from '../validate.js'

export async function getDocument(
  deps: ApplicationDeps,
  input: DocumentGetInput,
): Promise<Result<DocumentGetOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard(requestId, '读取文档失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    const context = validateReadContext(raw['context'])
    if (!context.ok) return context

    const documentId = requireId<DocumentId>(raw['documentId'], 'documentId', requestId)
    if (!documentId.ok) return documentId

    const found = await callPort(
      () => deps.persistence.documents.getDocument({ context: context.value, documentId: documentId.value }),
      requestId,
      '读取文档失败',
    )
    if (!found.ok) return found

    // 形状门禁：摘要与正文都必须存在，避免把半成品交给渲染层
    const record = asRecord(found.value)
    if (record === null || asRecord(record['document']) === null || typeof record['body'] !== 'string') {
      return fail(
        new TypeError('getDocument 端口返回了不符合 DocumentGetOutput 形状的值'),
        requestId,
        '读取到的文档数据形状非法',
      )
    }
    return { ok: true, value: { document: found.value.document, body: found.value.body } }
  })
}

/** 文档不存在时的契约文案（适配器可用同一句，保证前端只需识别一个 code）。 */
export const DOCUMENT_NOT_FOUND_MESSAGE = '文档不存在或已被删除'

/** 供适配器复用的「不存在」错误构造（适配器依赖端口层，方向不变）。 */
export function documentNotFound(requestId: RequestId): Result<never> {
  const missing = errOf('NOT_FOUND_DOCUMENT', DOCUMENT_NOT_FOUND_MESSAGE, requestId, {
    field: 'documentId',
  })
  return errFrom(missing.error, requestId)
}
