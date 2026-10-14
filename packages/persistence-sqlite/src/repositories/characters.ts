/**
 * `characters` —— 人物卡读写（P1-A3 Repository 层）。
 *
 * 🔴 存储落点（**契约与 Schema 的真实缺口**，本文件是它的唯一落点）：
 *    `packages/contracts/src/entities/index.ts:441` 定义了 `Character` 实体
 *    （`id/workspaceId/projectId/name/values/orderKey/revision/deleted/createdAt/updatedAt`），
 *    注释写「与 SettingsEntity 分离：人物字段是固定的，不走动态模板」；
 *    但 `packages/persistence-sqlite/src/schema/ddl.ts` 的 17 张表里**没有 characters 表**
 *    （`06-数据与本地存储.md` 的表清单同样没有）。
 *    因此唯一可行的落点是 `settings_entities`，用保留的模板 ID 区分三种卡面
 *    （`char-main` / `char-secondary` / `char-npc`）——这正是
 *    `docs/旧功能迁移矩阵.md:53`（F-07）与 `:148`（M-06）给出的映射：
 *    `cardRecords`（`char-main`/`char-secondary`/`char-npc`）→ `settings_entities`，
 *    `tabId → schema_template_id`、`id → id`（**保留旧 ID**）。
 *
 * ⚠️ 代价（必须让 Lead 知道）：`Character` 没有 `schemaTemplateId` 字段，
 *    所以本层的读写都要显式限定模板，否则会读到别的设定页签的数据。
 *    若 Lead 决定给 `Character` 加 `schemaTemplateId`，或新增 `characters` 表，
 *    本文件是唯一需要改的地方。
 *
 * 🔴 本层**只**做"人物卡形态的适配"：真正的 SQL、乐观锁、workspace 隔离、
 *    软删过滤全部复用 `settingsEntities.ts`——两份 SQL 必然漂移，
 *    而漂移出来的那个 bug 一定发生在"删除人物卡"这种低频路径上。
 */

import { errOf, newIds, type CharacterId, type ReadContext, type Result, type Revision, type WriteContext } from '@yfe/contracts'
import { type Character, type SettingsEntity, isWellFormedId } from '@yfe/contracts'

import type { SqliteDatabase } from '../schema/index.js'
import {
  createSettingsEntity,
  getSettingsEntity,
  listSettingsEntities,
  softDeleteSettingsEntity,
  updateSettingsEntity,
  type SettingsEntityPatch,
  type SettingsPlacement,
} from './settingsEntities.js'
import type { RepositoryDeps } from './internal.js'

/**
 * 人物卡默认模板 ID（主卡面）。
 *
 * 取值来自旧版 `cardRecords` 的 tabId（`docs/旧功能迁移矩阵.md:53`），
 * **不用**新造的名字：导入旧数据时 `schema_template_id` 要原样保留，
 * 否则同一个人的卡在新旧库里会变成两条互不相干的记录。
 */
export const CHARACTER_SCHEMA_TEMPLATE_ID = 'char-main'

/** 三种人物卡卡面（主卡 / 配角 / NPC），与旧版 tabId 一一对应。 */
export const CHARACTER_SCHEMA_TEMPLATE_IDS: readonly string[] = [
  'char-main',
  'char-secondary',
  'char-npc',
]

export function isCharacterSchemaTemplateId(value: unknown): boolean {
  return typeof value === 'string' && CHARACTER_SCHEMA_TEMPLATE_IDS.includes(value)
}

export interface CharacterCreateInput {
  readonly context: WriteContext
  readonly projectId: Character['projectId']
  readonly name: string
  /** 固定字段的取值（头像除外：`portrait` 走 `assets` + `asset_refs`，见 M-06）。 */
  readonly values?: Readonly<Record<string, unknown>>
  readonly placement?: SettingsPlacement
  /** 卡面模板 ID，默认 {@link CHARACTER_SCHEMA_TEMPLATE_ID}。 */
  readonly cardTemplateId?: string
}

export interface CharacterPatch {
  readonly name?: string
  readonly values?: Readonly<Record<string, unknown>>
}

function toCharacter(entity: SettingsEntity): Character {
  return {
    id: entity.id as CharacterId,
    workspaceId: entity.workspaceId,
    projectId: entity.projectId,
    name: entity.name,
    values: entity.values,
    orderKey: entity.orderKey,
    revision: entity.revision,
    deleted: entity.deleted,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

/** 读取结果必须是"人物卡形态"的行：模板 ID 不匹配时对外一律表现为不存在。 */
function requireCharacter(
  entityResult: Result<SettingsEntity>,
  characterId: string,
  requestId: ReadContext['requestId'],
): Result<SettingsEntity> {
  if (!entityResult.ok) {
    // 把设定层的通用 NOT_FOUND 文案换成人物卡语义（错误码保持契约不变）。
    if (entityResult.error.code === 'NOT_FOUND') {
      return errOf('NOT_FOUND', '人物卡不存在', requestId, { entityId: characterId })
    }
    return entityResult
  }
  if (!isCharacterSchemaTemplateId(entityResult.value.schemaTemplateId)) {
    // 这条记录确实是别的页签的设定（地点/势力/时间线……）：对人物卡 API 而言它不存在。
    // 不返回 PERMISSION_*：那会把"别的设定实体"的存在性与类型泄漏给人物卡路由。
    return errOf('NOT_FOUND', '人物卡不存在', requestId, { entityId: characterId })
  }
  return entityResult
}

/** 新建人物卡。 */
export function createCharacter(
  db: SqliteDatabase,
  input: CharacterCreateInput,
  deps: RepositoryDeps,
): Result<{ readonly characterId: CharacterId; readonly revision: Revision; readonly orderKey: string }> {
  const requestId = input.context.requestId
  const cardTemplateId = input.cardTemplateId ?? CHARACTER_SCHEMA_TEMPLATE_ID
  if (!isCharacterSchemaTemplateId(cardTemplateId)) {
    return errOf('VALIDATION_FAILED', '人物卡模板 ID 不合法', requestId, { field: 'cardTemplateId' })
  }

  const created = createSettingsEntity(
    db,
    {
      context: input.context,
      projectId: input.projectId,
      schemaTemplateId: cardTemplateId,
      name: input.name,
      values: input.values ?? {},
      entityId: newIds.character(deps.rng),
      ...(input.placement === undefined ? {} : { placement: input.placement }),
    },
    deps,
  )
  if (!created.ok) return created
  return {
    ok: true,
    value: {
      characterId: created.value.entityId as CharacterId,
      revision: created.value.revision,
      orderKey: created.value.orderKey,
    },
  }
}

/** 读取单张人物卡（默认不含已软删，要读已删的传 `{ includeDeleted: true }`）。 */
export function getCharacter(
  db: SqliteDatabase,
  context: ReadContext,
  characterId: string,
  options?: { readonly includeDeleted?: boolean },
): Result<Character> {
  const requestId = context.requestId
  if (!isWellFormedId(characterId)) {
    return errOf('VALIDATION_MALFORMED_ID', '人物卡 ID 格式不合法', requestId, { field: 'characterId' })
  }
  const entityResult = getSettingsEntity(db, context, characterId, options)
  const checked = requireCharacter(entityResult, characterId, requestId)
  if (!checked.ok) return checked
  return { ok: true, value: toCharacter(checked.value) }
}

/** 列出作品下的人物卡（三种卡面一起，按 `order_key, id` 排序）。 */
export function listCharacters(
  db: SqliteDatabase,
  context: ReadContext,
  projectId: Character['projectId'],
  options?: { readonly includeDeleted?: boolean },
): Result<readonly Character[]> {
  const entitiesResult = listSettingsEntities(db, {
    context,
    projectId,
    schemaTemplateIds: CHARACTER_SCHEMA_TEMPLATE_IDS,
    ...(options?.includeDeleted === undefined ? {} : { includeDeleted: options.includeDeleted }),
  })
  if (!entitiesResult.ok) return entitiesResult
  return { ok: true, value: entitiesResult.value.map(toCharacter) }
}

/** 更新人物卡（名称 / 整值替换）。 */
export function updateCharacter(
  db: SqliteDatabase,
  context: WriteContext,
  characterId: string,
  patch: CharacterPatch,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  if (!isWellFormedId(characterId)) {
    return errOf('VALIDATION_MALFORMED_ID', '人物卡 ID 格式不合法', requestId, { field: 'characterId' })
  }
  // 先确认这条记录确实是人物卡：不能借人物卡 API 改到别的设定页签的数据。
  const existing = getCharacter(db, context, characterId)
  if (!existing.ok) return existing

  const entityPatch: SettingsEntityPatch = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.values === undefined ? {} : { values: patch.values }),
  }
  return updateSettingsEntity(db, context, characterId, entityPatch, deps)
}

/** 软删人物卡（不级联：人物卡之间没有父子结构；关系图的行在 `relations`，另行处理）。 */
export function softDeleteCharacter(
  db: SqliteDatabase,
  context: WriteContext,
  characterId: string,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  if (!isWellFormedId(characterId)) {
    return errOf('VALIDATION_MALFORMED_ID', '人物卡 ID 格式不合法', requestId, { field: 'characterId' })
  }
  const existing = getCharacter(db, context, characterId)
  if (!existing.ok) return existing
  return softDeleteSettingsEntity(db, context, characterId, deps)
}
