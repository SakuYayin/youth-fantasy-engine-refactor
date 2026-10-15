/**
 * 标识符与不透明值类型。
 *
 * 设计约束（见 06-数据与本地存储.md）：
 * - 实体 / 任务 / 操作 ID 由客户端生成随机 UUID，不依赖服务端分配，离线可创建。
 * - revision 是不透明字符串，**禁止比较大小**、禁止做算术、禁止排序推断新旧。
 * - 游标是不透明字符串，可能超出 JS 安全整数范围，**禁止转 number**。
 * - 时间戳是 UTC 字符串，仅用于展示与审计，**不用于判定冲突胜者**。
 */

/** 品牌类型工具：防止把裸 string 当成特定 ID 误传。 */
declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type ProjectId = Brand<string, 'ProjectId'>
export type VolumeId = Brand<string, 'VolumeId'>
export type ChapterId = Brand<string, 'ChapterId'>
export type DocumentId = Brand<string, 'DocumentId'>
export type CharacterId = Brand<string, 'CharacterId'>
export type OutlineNodeId = Brand<string, 'OutlineNodeId'>
export type WorldSettingId = Brand<string, 'WorldSettingId'>
export type MaterialId = Brand<string, 'MaterialId'>
export type AttachmentId = Brand<string, 'AttachmentId'>
/** 附件内容 ID。与 `AttachmentId` 的区别：Asset 是**已校验发布的内容对象**，可能被多个引用共享。 */
export type AssetId = Brand<string, 'AssetId'>
export type SnapshotId = Brand<string, 'SnapshotId'>
export type JobId = Brand<string, 'JobId'>
export type UserId = Brand<string, 'UserId'>
export type DeviceId = Brand<string, 'DeviceId'>
export type PluginId = Brand<string, 'PluginId'>

/** 不透明修订号。字符串类型是刻意的：它挡住所有"比大小"的误用。 */
export type Revision = Brand<string, 'Revision'>

/** 不透明同步游标。可能是超大整数或带前缀的复合值，不得数值化。 */
export type Cursor = Brand<string, 'Cursor'>

/** 请求关联 ID，用于日志串联（见 10-开发规范与环境.md 调试章节）。 */
export type RequestId = Brand<string, 'RequestId'>

/** UTC ISO-8601 时间戳字符串，如 `2026-10-14T18:00:00.000Z`。 */
export type UtcTimestamp = Brand<string, 'UtcTimestamp'>

/** 幂等键：同一 requestId 重复提交必须产生同一结果。 */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

// ---------------------------------------------------------------------------
// 运行时构造与校验
// ---------------------------------------------------------------------------

/**
 * 允许的标识符字符集：UUID v4/v7 形态，或 `前缀_随机串` 形态。
 * 刻意收窄，避免路径穿越、SQL 拼接与不可见字符进入主键。
 */
const ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/

export function isWellFormedId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !value.includes('..')
}

/** 生成随机 ID。注入随机源以便测试可重复（见 10-开发规范与环境.md：随机 ID 以接口注入）。 */
export interface RandomSource {
  uuid(): string
}

export const cryptoRandomSource: RandomSource = {
  uuid(): string {
    return globalThis.crypto.randomUUID()
  },
}

export function makeId<T extends string>(prefix: string, rng: RandomSource = cryptoRandomSource): T {
  const raw = rng.uuid().replace(/-/g, '')
  return `${prefix}_${raw.slice(0, 26)}` as T
}

/** 各实体的 ID 工厂。统一前缀便于日志里一眼看出类型。 */
export const newIds = {
  workspace: (rng?: RandomSource) => makeId<WorkspaceId>('ws', rng),
  project: (rng?: RandomSource) => makeId<ProjectId>('prj', rng),
  volume: (rng?: RandomSource) => makeId<VolumeId>('vol', rng),
  chapter: (rng?: RandomSource) => makeId<ChapterId>('chp', rng),
  document: (rng?: RandomSource) => makeId<DocumentId>('doc', rng),
  character: (rng?: RandomSource) => makeId<CharacterId>('chr', rng),
  outlineNode: (rng?: RandomSource) => makeId<OutlineNodeId>('out', rng),
  worldSetting: (rng?: RandomSource) => makeId<WorldSettingId>('wld', rng),
  material: (rng?: RandomSource) => makeId<MaterialId>('mat', rng),
  attachment: (rng?: RandomSource) => makeId<AttachmentId>('att', rng),
  asset: (rng?: RandomSource) => makeId<AssetId>('ast', rng),
  snapshot: (rng?: RandomSource) => makeId<SnapshotId>('snp', rng),
  job: (rng?: RandomSource) => makeId<JobId>('job', rng),
  user: (rng?: RandomSource) => makeId<UserId>('usr', rng),
  device: (rng?: RandomSource) => makeId<DeviceId>('dev', rng),
  plugin: (rng?: RandomSource) => makeId<PluginId>('plg', rng),
  request: (rng?: RandomSource) => makeId<RequestId>('req', rng),
}

// ---------------------------------------------------------------------------
// revision / cursor 处理
// ---------------------------------------------------------------------------

/**
 * 由单调递增整数编码为不透明 revision。
 *
 * 编码而非直接用数字，是为了让调用方无法顺手做 `a > b` 的比较：
 * 排序语义属于存储层，不属于调用方契约。
 */
export function encodeRevision(seq: number): Revision {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`revision 序列必须是 >=1 的安全整数，收到 ${seq}`)
  }
  return `r${seq.toString(36).padStart(8, '0')}` as Revision
}

/**
 * 可跨离线副本使用的修订标识；排序仍只用库内 revision_seq。
 * 同一文档在两台离线设备上都会推进到相同序号，不能仅用序号作为身份。
 */
export function newRevision(seq: number, rng: RandomSource = cryptoRandomSource): Revision {
  encodeRevision(seq) // 保留安全整数与溢出校验。
  return `rev_${rng.uuid()}` as Revision
}

/** 游标编码：同样刻意不做数值暴露。 */
export function encodeCursor(seq: number, scope: string): Cursor {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`cursor 序列必须是 >=0 的安全整数，收到 ${seq}`)
  }
  return `${scope}:${seq.toString(36)}` as Cursor
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** 注入式时钟，便于可重复故障测试。 */
export interface Clock {
  now(): UtcTimestamp
}

export const systemClock: Clock = {
  now(): UtcTimestamp {
    return new Date().toISOString() as UtcTimestamp
  },
}

/** 固定时钟，仅用于测试。 */
export function fixedClock(iso: string): Clock {
  return { now: () => iso as UtcTimestamp }
}

export function isUtcTimestamp(value: unknown): value is UtcTimestamp {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

/**
 * 冲突裁决的唯一合法输入。
 *
 * 🔴 刻意**不**提供基于时间戳的胜负判断：设备时钟不同步会让"后写胜"变成随机结果。
 * 正确做法是保留双方版本、由用户或三方合并决定（见 07-同步协议与API.md）。
 */
export interface ConflictWinnerInput {
  /** 本地基线 revision。 */
  readonly baseRevision: Revision | null
  /** 本地已提交的 revision。 */
  readonly localRevision: Revision
  /** 远端当前 revision。 */
  readonly remoteRevision: Revision
}

export type ConflictOutcome =
  | { readonly kind: 'fast-forward' }
  | { readonly kind: 'already-current' }
  | { readonly kind: 'conflict'; readonly reason: 'diverged' }
  | { readonly kind: 'delete-update'; readonly reason: 'local-deleted' | 'remote-deleted' }

/**
 * 判定同步结果。只比较**是否相等**，从不比较大小或时间。
 * 这是数据安全的核心函数，任何"谁更新"的推断都必须走这里。
 */
export function resolveConflict(input: ConflictWinnerInput): ConflictOutcome {
  const { baseRevision, localRevision, remoteRevision } = input

  if (baseRevision === null) {
    // 本地没有基线：远端要么是首次同步，要么本地是新建。
    return localRevision === remoteRevision ? { kind: 'already-current' } : { kind: 'fast-forward' }
  }
  if (localRevision === remoteRevision) return { kind: 'already-current' }
  if (baseRevision === remoteRevision) return { kind: 'fast-forward' }
  return { kind: 'conflict', reason: 'diverged' }
}
