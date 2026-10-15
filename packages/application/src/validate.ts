/**
 * 入参校验与归一。
 *
 * 三条铁律（对应 `docs/契约速查.md` 与 `10-开发规范与环境.md`）：
 *
 * 1. **不信任任何入参**：`input.context` 也是入参。ID 形状先校验，绝不让
 *    `../` 形态的字符串走到存储层。
 * 2. **不改写正文**：`body` 归一化属于 `@yfe/domain` 的 `normalizeBody`，
 *    本层只做「是不是字符串」这一层门禁（持久化层的 `writeDocumentBody` 负责落库，
 *    本层**不截断**，否则会静默丢字）。
 * 3. **不改写输入对象**：校验函数只读入参并返回新对象，避免调用方复用入参时被我们污染。
 *
 * 校验失败一律返回契约 `Err`（`VALIDATION_*`），不抛异常——异常只用于「不该发生」的
 * 情况，由 {@link import('./errors.js').callPort} 收敛。
 */

import {
  isDocumentKind,
  isWellFormedId,
  type DocumentCreateInput,
  type DocumentId,
  type DocumentKind,
  type ProjectId,
  type ReadContext,
  type RequestId,
  type Result,
  type Revision,
  type UtcTimestamp,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'

import { invalid } from './errors.js'

/** 标题（文档/章节）长度上限：文案边界，超出即拒绝，不静默截断。 */
export const MAX_TITLE_LENGTH = 200
/** 作品名长度上限。 */
export const MAX_PROJECT_NAME_LENGTH = 100
/** 作品简介长度上限（可选字段，允许为空串）。 */
export const MAX_SUMMARY_LENGTH = 500
/** 编辑器会话 ID 长度上限。 */
export const MAX_SESSION_ID_LENGTH = 128
/** 模板 ID 长度上限。 */
export const MAX_TEMPLATE_ID_LENGTH = 128
/**
 * 设定实体 / 人物卡名称长度上限。
 *
 * 🔴 必须与 `@yfe/persistence-sqlite` 的 `MAX_ENTITY_NAME_LENGTH` 保持一致：
 *    应用层先拦一次是为了给出**带字段名**的错误，存储层那次是最后一道防线。
 */
export const MAX_ENTITY_NAME_LENGTH = 200
/**
 * 排序键长度上限。
 *
 * 与 `@yfe/domain/orderKey` 的 `MAX_KEY_LENGTH` 一致（那里是私有常量，不导出，
 * 所以这里重复一个数字并注明来源）。**只校验长度**：分数索引的字符集规则
 * 由存储层的 `requireOrderKey` 判定，本层不引入 `@yfe/domain` 依赖。
 */
export const MAX_ORDER_KEY_LENGTH = 512

// ---------------------------------------------------------------------------
// 错误构造小工具（统一文案风格，避免每个用例各写一遍）
// ---------------------------------------------------------------------------

/** 必填字段缺失/为空。 */
export function missingField(field: string, requestId: RequestId): Result<never> {
  return invalid('VALIDATION_MISSING_FIELD', `${field} 缺失或为空`, requestId, { field })
}

/** ID 形状非法（含 `..`、超长、非法字符）。 */
export function malformedId(field: string, requestId: RequestId): Result<never> {
  return invalid('VALIDATION_MALFORMED_ID', `${field} 格式非法`, requestId, { field })
}

/** 字段形状/类型不符契约。 */
export function badField(
  field: string,
  requestId: RequestId,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): Result<never> {
  return invalid('VALIDATION_FAILED', message, requestId, { field, ...detail })
}

/** 数值越界。 */
export function outOfRange(
  field: string,
  requestId: RequestId,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): Result<never> {
  return invalid('VALIDATION_OUT_OF_RANGE', message, requestId, { field, ...detail })
}

// ---------------------------------------------------------------------------
// 基础读取
// ---------------------------------------------------------------------------

/** 把不可信值当对象读取；非对象返回 `null`（用例拿它做「入参是不是对象」的门禁）。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * 从（可能非法的）上下文中尽力取回 `requestId`。
 *
 * 用于「context 本身校验就失败」的场景：此时没有可信 requestId，
 * 用固定占位符而不是随机生成（本包禁止随机、且占位符可被检索定位）。
 */
export function requestIdOf(context: unknown): RequestId {
  const record = asRecord(context)
  const candidate = record?.['requestId']
  return typeof candidate === 'string' && candidate.length > 0 ? (candidate as RequestId) : UNKNOWN_REQUEST_ID
}

/** 校验失败且取不到 requestId 时的稳定占位符。 */
export const UNKNOWN_REQUEST_ID = 'req-unknown' as RequestId

/** `value` 是非空字符串则原样返回，否则 `null`。 */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** ID 字段：形状必须过 `isWellFormedId`。 */
export function requireId<T extends string>(
  value: unknown,
  field: string,
  requestId: RequestId,
): Result<T> {
  const text = nonEmptyString(value)
  if (text === null) return missingField(field, requestId) as Result<T>
  return isWellFormedId(text) ? { ok: true, value: text as T } : (malformedId(field, requestId) as Result<T>)
}

/** 必填文本：非空字符串、长度不超上限（不做 trim；「空格」也是作者输入）。 */
export function requireText(
  value: unknown,
  field: string,
  requestId: RequestId,
  maxLength: number,
): Result<string> {
  const text = nonEmptyString(value)
  if (text === null) return missingField(field, requestId)
  if (text.length > maxLength) {
    return outOfRange(field, requestId, `${field} 超过长度上限 ${maxLength}`, {
      actualLength: text.length,
      maxLength,
    })
  }
  return { ok: true, value: text }
}

/**
 * 动态 Schema 字段值：必须是 JSON **对象**（`null` 与数组都不算）。
 *
 * 这里只判定「是不是对象」，不逐字段判类型——字段由 `schemaTemplateId` 指向的模板决定，
 * 应用层不认识具体模板。真正的序列化可行性由存储层的 `stringifyValues` 兜底。
 */
export function requireValuesRecord(
  value: unknown,
  field: string,
  requestId: RequestId,
): Result<Readonly<Record<string, unknown>>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    return badField(field, requestId, `${field} 必须是 JSON 对象`, { received })
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 可选文本：`undefined`/`null` 归一为缺省值；不做类型猜测。 */
export function normalizeOptionalText(value: unknown, maxLength: number, fallback = ''): string {
  const text = nonEmptyString(value)
  if (text === null) return fallback
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

/** 可选的布尔开关（如 `seedFirstChapter` / `includeDeleted`），非布尔一律按缺省值。 */
export function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** `expectedRevision`：`null` 表示「不校验版本」，非空字符串表示「必须相等」。 */
export function requireNullableRevision(
  value: unknown,
  field: string,
  requestId: RequestId,
): Result<Revision | null> {
  if (value === null || value === undefined) return { ok: true, value: null }
  const text = nonEmptyString(value)
  if (text === null) return badField(field, requestId, `${field} 必须是 null 或非空字符串`)
  return { ok: true, value: text as Revision }
}

/** 编辑器本地草稿序号：非负安全整数。 */
export function requireDraftSequence(value: unknown, requestId: RequestId): Result<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return outOfRange(
      'draftSequence',
      requestId,
      'draftSequence 必须是从 0 开始单调递增的安全整数',
      { received: typeof value === 'number' ? value : typeof value },
    )
  }
  return { ok: true, value }
}

/** 文档类型。 */
export function requireKind(value: unknown, requestId: RequestId): Result<DocumentKind> {
  if (!isDocumentKind(value)) {
    return badField('kind', requestId, 'kind 不是受支持的文档类型', {
      received: typeof value === 'string' ? value : typeof value,
    })
  }
  return { ok: true, value }
}

/** 插入位置：`{mode:'end'}` 或 `{mode:'after', afterId}`。 */
export function requirePlacement(
  value: unknown,
  requestId: RequestId,
): Result<DocumentCreateInput['placement']> {
  const record = asRecord(value)
  if (record === null) return badField('placement', requestId, 'placement 必须是对象')
  const mode = record['mode']
  if (mode === 'end') return { ok: true, value: { mode: 'end' } }
  if (mode === 'after') {
    const afterId = requireId<DocumentId>(record['afterId'], 'placement.afterId', requestId)
    if (!afterId.ok) return afterId
    return { ok: true, value: { mode: 'after', afterId: afterId.value } }
  }
  return badField('placement.mode', requestId, "placement.mode 只支持 'end' 或 'after'", {
    received: typeof mode === 'string' ? mode : typeof mode,
  })
}

/** 时间戳字段（如宿主的 `lastSavedAt`），必须是非空字符串。 */
export function requireTimestamp(
  value: unknown,
  field: string,
  requestId: RequestId,
): Result<UtcTimestamp> {
  const text = nonEmptyString(value)
  if (text === null) return badField(field, requestId, `${field} 必须是 ISO-8601 时间戳字符串`)
  return { ok: true, value: text as UtcTimestamp }
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

/** 写上下文：`requestId` / `workspaceId` 必填且形状合法，`projectId` 可空。 */
export function validateWriteContext(context: unknown): Result<WriteContext> {
  const requestId = requestIdOf(context)
  const record = asRecord(context)
  if (record === null) return badField('context', requestId, 'context 缺失或不是对象')

  const requestIdCheck = requireId<RequestId>(record['requestId'], 'context.requestId', requestId)
  if (!requestIdCheck.ok) return requestIdCheck

  const workspaceIdCheck = requireId<WorkspaceId>(record['workspaceId'], 'context.workspaceId', requestId)
  if (!workspaceIdCheck.ok) return workspaceIdCheck

  const rawProjectId = record['projectId']
  let projectId: ProjectId | null = null
  if (rawProjectId !== null && rawProjectId !== undefined) {
    const projectCheck = requireId<ProjectId>(rawProjectId, 'context.projectId', requestId)
    if (!projectCheck.ok) return projectCheck
    projectId = projectCheck.value
  }

  const revisionCheck = requireNullableRevision(record['expectedRevision'], 'context.expectedRevision', requestId)
  if (!revisionCheck.ok) return revisionCheck

  let idempotencyKey: WriteContext['idempotencyKey']
  const rawKey = record['idempotencyKey']
  if (rawKey !== null && rawKey !== undefined) {
    const keyCheck = requireId<NonNullable<WriteContext['idempotencyKey']>>(
      rawKey,
      'context.idempotencyKey',
      requestId,
    )
    if (!keyCheck.ok) return keyCheck
    idempotencyKey = keyCheck.value
  }

  return {
    ok: true,
    value: {
      requestId: requestIdCheck.value,
      workspaceId: workspaceIdCheck.value,
      projectId,
      expectedRevision: revisionCheck.value,
      idempotencyKey,
    },
  }
}

/** 读上下文：只有 `requestId` / `workspaceId`。 */
export function validateReadContext(context: unknown): Result<ReadContext> {
  const requestId = requestIdOf(context)
  const record = asRecord(context)
  if (record === null) return badField('context', requestId, 'context 缺失或不是对象')

  const requestIdCheck = requireId<RequestId>(record['requestId'], 'context.requestId', requestId)
  if (!requestIdCheck.ok) return requestIdCheck

  const workspaceIdCheck = requireId<WorkspaceId>(record['workspaceId'], 'context.workspaceId', requestId)
  if (!workspaceIdCheck.ok) return workspaceIdCheck

  return { ok: true, value: { requestId: requestIdCheck.value, workspaceId: workspaceIdCheck.value } }
}

// ---------------------------------------------------------------------------
// 正文
// ---------------------------------------------------------------------------

/** 正文门禁：`body` 必须是字符串（内容不做任何改写，也不截断）。 */
export function requireBody(value: unknown, requestId: RequestId): Result<string> {
  if (typeof value !== 'string') {
    return badField('body', requestId, 'body 必须是已归一化的字符串', { received: typeof value })
  }
  return { ok: true, value }
}
