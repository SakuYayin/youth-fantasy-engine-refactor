/**
 * 确定性 ID 映射（**同一旧实体两次导入必须得到同一个新 ID**）。
 *
 * 设计依据 `docs/旧功能迁移矩阵.md` §2.4 第 2 步：「只读解析副本，建立旧 ID/字段映射」。
 *
 * 🔴 规则（可复现、可审计、与运行次数无关）：
 *
 * ```
 * canonicalKey = "legacy\0<sourceId>\0<database>\0<store>\0<legacyId>[\0<qualifier>]"
 * digest       = sha256(canonicalKey) 的 64 位小写十六进制
 * newId        = "<prefix>_" + digest[0..40)
 * ```
 *
 * 三点刻意的设计：
 *
 * 1. **分隔符用 `U+0000` 而不是 `:`**。迁移矩阵把规则写成
 *    `legacy:<源>:<库>:<store>:<旧键>`，但新库主键受
 *    `packages/contracts/src/ids.ts:56` 的 `ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/`
 *    约束——**冒号与中文都不合法**，而旧 `id` 里恰恰两者都可能出现
 *    （旧版 `formData` 的键就是 `` `${projectId}::${tabId}` ``）。NUL 在任何合法 ID
 *    字符集里都不出现，因此「拼接无歧义」这条性质被真正保住；旧键原样进哈希、不进主键。
 * 2. **哈希而不是转义**。转义（如 `encodeURIComponent`）会把长度撑到 128 上限之外，
 *    且需要一个与 `ID_PATTERN` 同步维护的字符表——两处字符表迟早漂移。
 *    40 位 hex（160 bit）的碰撞概率在「本地写作软件的章节量级」下可忽略，
 *    且本包仍然**显式检测**碰撞并写进报告（{@link IdCollisionEntry}），不靠概率当保证。
 * 3. **`qualifier` 保留旧键的从属关系**。同一条旧键派生出多个新实体时（快照 → 多条
 *    `revisions`、章节旁存 → 多条 `config_values`），用第 5 段区分；不填 = 主实体。
 *    这保证「主实体」与「派生行」的 ID 空间互不干扰、又都能从旧键重算。
 */

import { createHash } from 'node:crypto'

import { isWellFormedId } from '@yfe/contracts'

/** 算法标识。写进报告与导入水位线，让「ID 是怎么来的」可复算。 */
export const LEGACY_ID_ALGORITHM = 'legacy-id-sha256-v1'

/** 取哈希的前 40 位十六进制（160 bit）。 */
export const LEGACY_ID_DIGEST_LENGTH = 40

/**
 * 新实体的前缀。刻意复用新版已有的前缀语义
 * （`packages/contracts/src/ids.ts` 的 `newIds`），让日志里一眼能看出类型：
 * `prj_` 作品、`vol_` 卷、`doc_` 章 / 笔记、`chr_` 人物卡、`set_` 设定实体、
 * `rev_` 修订历史、`rel_` 引用关系。
 *
 * ⚠️ `vol_` / `doc_` 都不是 `newIds.volume` / `newIds.document` 的原样前缀
 *    （那两个是 `vol_` / `doc_` + 26 位随机串）——本包不产生随机 ID，
 *    但前缀形态与长度都在 `ID_PATTERN` 之内，主键列不区分来源。
 */
export type LegacyIdPrefix = 'ws' | 'prj' | 'vol' | 'doc' | 'chr' | 'set' | 'rev' | 'rel' | 'cfg'

/** 一条旧实体的身份四元组（+ 可选派生限定符）。 */
export interface LegacyKeyParts {
  readonly sourceId: string
  readonly database: string
  readonly store: string
  readonly legacyId: string
  /** 同一条旧键派生的第 N 个新实体。不填 = 主实体。 */
  readonly qualifier?: string | null
}

/** 字段分隔符。见文件头 🔴 第 1 点：为什么不是 `:`。 */
const SEP = '\u0000'

/** 可复现的规范键。写进报告与水位线，是「ID 从哪来」的唯一真值。 */
export function canonicalLegacyKey(parts: LegacyKeyParts): string {
  const head = `legacy${SEP}${parts.sourceId}${SEP}${parts.database}${SEP}${parts.store}${SEP}${parts.legacyId}`
  const qualifier = parts.qualifier
  return qualifier === undefined || qualifier === null || qualifier === ''
    ? head
    : `${head}${SEP}${qualifier}`
}

/** `sha256(canonicalKey)` 的 64 位小写十六进制。 */
export function legacyKeyDigest(parts: LegacyKeyParts): string {
  return createHash('sha256').update(canonicalLegacyKey(parts), 'utf8').digest('hex')
}

/**
 * 由旧键推出稳定新 ID。
 *
 * 🔴 纯函数：**不看数据库、不看时钟、不看随机源**。这正是「幂等重跑」成立的前提——
 *    同一个旧实体在任何一次导入里都算出同一个 ID，重跑只会命中同 ID 走更新/跳过，
 *    不会产生重复实体或重复 revision。
 */
export function legacyEntityId(prefix: LegacyIdPrefix, parts: LegacyKeyParts): string {
  const digest = legacyKeyDigest(parts)
  const id = `${prefix}_${digest.slice(0, LEGACY_ID_DIGEST_LENGTH)}`
  if (!isWellFormedId(id)) {
    // 不可能发生（前缀是字面量、后缀是 hex），但绝不静默产生非法主键：
    // 非法 ID 会在 `createDocument` 里变成 VALIDATION_MALFORMED_ID，
    // 那时再排查要往回翻上百里映射代码。
    throw new Error(
      `legacyEntityId 生成了不符合 ID_PATTERN 的标识符（prefix=${prefix}，摘要长度=${digest.length}）`,
    )
  }
  return id
}

/** 同一条旧键的派生行 ID（快照 → revision、旁存 → config_value）。 */
export function legacyDerivedId(
  prefix: LegacyIdPrefix,
  parts: LegacyKeyParts,
  qualifier: string,
): string {
  return legacyEntityId(prefix, { ...parts, qualifier })
}
