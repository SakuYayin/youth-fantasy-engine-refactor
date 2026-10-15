/**
 * 用例 `saveDraft`：本地草稿提交（本项目最热的一条写路径）。
 *
 * 与持久化层 `@yfe/persistence-sqlite/src/saveDraft/saveDraft.ts` 的分工：
 *
 * | 谁 | 负责什么 |
 * | --- | --- |
 * | 本用例 | 入参形状校验、**归属授权**（workspaceId / projectId）、`expectedRevision` 预检、注入时钟、请求级幂等、错误归一 |
 * | 端口/适配器 | 事务内重新校验、乐观锁 CAS、写正文与新 revision、写版本记录、operation 与 outbox、`charCount` 计算 |
 *
 * 🔴 授权必须基于**库内事实**：`context.projectId` 只用来和 `ownership.projectId` 比对，
 *    绝不接受 payload 自报的归属。客户端声称「这是作品 B 的文档」不构成任何权限。
 * 🔴 这里的 `expectedRevision` 预检只是**快速失败**（少开一次写事务），权威判定仍在
 *    适配器事务内的 CAS；两处共用同一错误码与同一句文案，调用方只需处理一种情形。
 */

import {
  errOf,
  type DocumentId,
  type RequestId,
  type Result,
  type SaveDraftInput,
  type SaveDraftOutput,
} from '@yfe/contracts'

import { callPort, callPortNullable, errFrom, fail, guard } from '../errors.js'
import { withIdempotency } from '../idempotency.js'
import { isDocumentOwnership, type ApplicationDeps, type DocumentOwnership } from '../ports.js'
import {
  MAX_SESSION_ID_LENGTH,
  asRecord,
  requestIdOf,
  requireBody,
  requireDraftSequence,
  requireId,
  requireText,
  validateWriteContext,
} from '../validate.js'

/** 幂等作用域：同键跨用例必须报 `IDEMPOTENCY_KEY_REUSED`。 */
export const SAVE_DRAFT_SCOPE = 'saveDraft'

/** `expectedRevision` 过期时的文案（与持久化层逐字一致，调用方只需处理一种情形）。 */
export const REVISION_CONFLICT_MESSAGE = '文档已被其他改动推进，请基于最新版本重试'

/** 文档归属与 context 声明不符时的文案。 */
export const PROJECT_MISMATCH_MESSAGE = '该文档不属于 context 声明的作品'

export async function saveDraft(
  deps: ApplicationDeps,
  input: SaveDraftInput,
): Promise<Result<SaveDraftOutput>> {
  const raw = asRecord(input)
  const requestId = requestIdOf(raw?.['context'])

  return guard<SaveDraftOutput>(requestId, '保存草稿失败', async () => {
    if (raw === null) {
      const bad = errOf('VALIDATION_FAILED', '入参缺失或不是对象', requestId, { field: 'input' })
      return errFrom(bad.error, requestId)
    }

    // 1) 上下文与各字段的形状校验（错误码只取自契约 ERROR_CODES）
    const context = validateWriteContext(raw['context'])
    if (!context.ok) return context

    const documentId = requireId<DocumentId>(raw['documentId'], 'documentId', requestId)
    if (!documentId.ok) return documentId

    const draftSequence = requireDraftSequence(raw['draftSequence'], requestId)
    if (!draftSequence.ok) return draftSequence

    const body = requireBody(raw['body'], requestId)
    if (!body.ok) return body

    const sessionId = requireText(raw['sessionId'], 'sessionId', requestId, MAX_SESSION_ID_LENGTH)
    if (!sessionId.ok) return sessionId

    // 2) 读库内归属（不含正文）
    const loaded = await callPortNullable(
      () => deps.persistence.draft.loadDocument(documentId.value),
      requestId,
      '读取文档归属失败',
    )
    if (!loaded.ok) return loaded

    const ownership = loaded.value
    if (ownership === null) {
      const missing = errOf('NOT_FOUND_DOCUMENT', '文档不存在或已被删除', requestId, {
        field: 'documentId',
      })
      return errFrom(missing.error, requestId)
    }
    if (!isDocumentOwnership(ownership)) {
      return fail(
        new TypeError('loadDocument 返回了不符合 DocumentOwnership 形状的值'),
        requestId,
        '文档归属数据形状非法，无法安全保存',
      )
    }

    // 3) 归属授权：只用库内真值
    const denied = authorize(ownership, context.value.workspaceId, context.value.projectId, requestId)
    if (denied !== null) return denied

    // 5) 提交：时钟由用例注入（适配器不得自己取时间），幂等键在本层解析与缓存
    const committed = await withIdempotency(
      deps.persistence.idempotency,
      SAVE_DRAFT_SCOPE,
      context.value.idempotencyKey,
      requestId,
      () => {
        // 版本判定与水位线重放均在事务内，授权始终先于幂等回执。
        return callPort(
          () =>
            deps.persistence.draft.commitDraft({
              input: {
                context: context.value,
                documentId: documentId.value,
                draftSequence: draftSequence.value,
                body: body.value,
                sessionId: sessionId.value,
              },
              ownership,
              occurredAt: deps.clock.now(),
            }),
          requestId,
          '草稿提交失败',
        )
      },
      JSON.stringify([context.value.workspaceId, context.value.projectId, documentId.value,
        context.value.expectedRevision, sessionId.value, draftSequence.value, body.value]),
    )
    if (!committed.ok) return committed

    // 6) 输出形状门禁：缺字段一律 INTERNAL_ERROR，绝不外发半成品
    const record = asRecord(committed.value)
    if (record === null) {
      return fail(new TypeError('commitDraft 返回了非对象输出'), requestId, '草稿提交结果形状非法')
    }
    const revision = record['revision']
    const savedAt = record['savedAt']
    const confirmedSequence = record['draftSequence']
    const charCount = record['charCount']
    if (
      typeof revision !== 'string' ||
      revision.length === 0 ||
      typeof savedAt !== 'string' ||
      savedAt.length === 0 ||
      typeof confirmedSequence !== 'number' ||
      typeof charCount !== 'number'
    ) {
      const malformed = errOf('INTERNAL_ERROR', '草稿提交结果缺少必要字段', requestId, {
        field: 'SaveDraftOutput',
      })
      return errFrom(malformed.error, requestId)
    }
    return {
      ok: true,
      value: { revision: committed.value.revision, draftSequence: committed.value.draftSequence, charCount: committed.value.charCount, savedAt: committed.value.savedAt },
    }
  })
}

/** 工作区 + 软删 + 作品归属检查。通过返回 `null`，否则返回可直接上抛的 `Err`。 */
function authorize(
  ownership: DocumentOwnership,
  workspaceId: string,
  projectId: string | null,
  requestId: RequestId,
): Result<never> | null {
  if (ownership.workspaceId !== workspaceId) {
    const cross = errOf('PERMISSION_WORKSPACE_MISMATCH', '该文档不属于当前工作区', requestId, {
      field: 'workspaceId',
    })
    return errFrom(cross.error, requestId)
  }
  if (ownership.deleted !== 0) {
    const gone = errOf('NOT_FOUND_DOCUMENT', '文档不存在或已被删除', requestId, {
      field: 'documentId',
    })
    return errFrom(gone.error, requestId)
  }
  if (projectId !== null && projectId !== ownership.projectId) {
    const mismatch = errOf('PERMISSION_WORKSPACE_MISMATCH', PROJECT_MISMATCH_MESSAGE, requestId, {
      field: 'projectId',
    })
    return errFrom(mismatch.error, requestId)
  }
  return null
}
