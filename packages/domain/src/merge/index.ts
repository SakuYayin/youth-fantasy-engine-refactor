/**
 * `@yfe/domain/merge` —— 合并判定（**刻意不做自动正文合并**）。
 *
 * ## 为什么不做自动合并
 *
 * ADR 007（`13-决策与资料.md`）与 `07-同步协议与API.md` 明确规定：
 * 「首版不做实时多人编辑 CRDT，正文冲突保留双方版本」、
 * 「不使用最后写入者全量覆盖」、「能证明不重叠的文本合并作为后续增强」。
 *
 * 自研 CRDT / 文本合并的正确性风险远高于它节省的一次点击，因此本模块只回答一个问题：
 *
 * > **这次远端变更能不能自动落地？还是必须保留双方版本交给用户裁决？**
 *
 * 裁决依据分两层，缺一不可：
 *
 * 1. **revision 图**（是否分歧）→ 一律交给 `@yfe/contracts` 的 `resolveConflict`。
 *    🔴 本模块**绝不自造**"谁更新"的判断，绝不比较 revision 大小，绝不用时间戳。
 * 2. **删除标志与字段值**（分歧落在什么上）→ 由本模块判定。
 *    `resolveConflict` 只看 revision，看不到 tombstone，所以
 *    「远端删除 vs 本地未改」这类情形必须在这一层补齐。
 *
 * ## 方向说明（重要，别误读 `fast-forward`）
 *
 * `resolveConflict` 的 `fast-forward` 含义是「**可以无冲突地向前推进**」，方向由调用方决定：
 * 通信方向是本地 → 远端时为「把本地推上去」，远端 → 本地时为「采用远端」。
 * 本模块固定表述**远端变更到达本地**时的本地动作，因此：
 *
 * | `resolveConflict` 裁决 | 本地动作 | 理由 |
 * | --- | --- | --- |
 * | `already-current` | `already-current` | 两侧同一 revision，无事可做 |
 * | `fast-forward`（等价于 `base === remote`） | `keep-local` | 本地领先，等待推送，不能拿旧远端覆盖 |
 * | `conflict: diverged` **且本地未变**（`base === local`） | `take-remote` | 本地无修改，采用远端安全 |
 * | `conflict: diverged` **且双方都改过** | `keep-both` | 双方都改过，保留双方版本 |
 *
 * 🔴 注意第 2、3 行的不对称，别把它当笔误：`resolveConflict` **只在 `base === remote` 时**
 * 返回 `fast-forward`；`base === local`（本地未变、远端前进）返回的是 `conflict: diverged`。
 * 也就是「本地没改」这件事**并不在契约的裁决结果里**，必须由本模块自己比较
 * `local.revision === base.revision` 才能得出 `take-remote`。
 * 所以准确的表述是：**分歧与否来自契约，而「哪一侧没改」由本层补齐**。
 * （契约 `ConflictOutcome` 里的 `delete-update` 变体同理永远不由 `resolveConflict` 产生——
 * 删除语义只在本模块的「第 2 步」里出现。）
 *
 * 每个决策都带回 `outcome` 字段作为审计证据，测试也逐例断言两者一致。
 *
 * ## 无共同基线（`base === null`）为什么默认升级为冲突
 *
 * 没有共同祖先就**无法证明双方改的是不同地方**，字段级合并的前提不成立。
 * `resolveConflict` 在 `base === null` 时给出 `fast-forward`（「远端是首个权威版本」），
 * 这对**首次同步**是对的；但若本地还握着未推送的稿件，直接采用远端就等于
 * 清空未同步稿件——`07-同步协议与API.md` 明令禁止。
 * 由于"本地是否有未推送改动"不在 `resolveConflict` 的入参里，本模块把它做成
 * 显式选项：默认**保守**升级为 `keep-both`；调用方确知本地干净时可传
 * `adoptRemoteWhenNoBase: true` 以严格采用契约的 `fast-forward` 语义。
 */

import { resolveConflict } from '@yfe/contracts'
import type { ConflictKind, ConflictOutcome, DeletedFlag, Revision } from '@yfe/contracts'

/**
 * 冲突裁决的唯一入口**仍然**在契约层；此处再导出一次，只为让
 * `@yfe/domain` 的使用者不必为了同一个判断去猜该从哪个包拿。
 */
export { resolveConflict } from '@yfe/contracts'
export type { ConflictOutcome, ConflictWinnerInput } from '@yfe/contracts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 参与合并的一方（本地或远端）。 */
export interface MergeVersion<T> {
  /** 不透明修订号，只做相等比较。 */
  readonly revision: Revision
  /** 软删除标志：`0` = 存活，非 `0` = 删除时间戳（墓碑）。 */
  readonly deleted: DeletedFlag
  /** 该版本承载的载荷（正文 / 字段值 / 行的完整状态）。 */
  readonly value: T
}

/** 本地要执行的动作。 */
export type MergeAction =
  /** 两侧同一 revision：什么都不做。 */
  | 'already-current'
  /** 保留本地：远端没有新变化，本地变更等待推送。 */
  | 'keep-local'
  /** 采用远端：本地无本地修改，可安全落地（含远端墓碑）。 */
  | 'take-remote'
  /** 保留双方版本：落一条 `Conflict`，远端存影子版本，**不覆盖输入框**。 */
  | 'keep-both'

/** 为什么得出这个动作（写进日志/冲突记录，便于事后复盘）。 */
export type MergeReason =
  | 'identical-revision'
  | 'remote-unchanged'
  | 'local-unchanged'
  | 'no-common-base'
  | 'diverged'
  | 'both-deleted'
  | 'remote-deleted'
  | 'local-deleted'
  | 'delete-vs-edit'

/** 需要落库的冲突事实（`Conflict` 行的领域侧部分）。 */
export interface MergeConflictFact {
  /** 映射到 `Conflict.kind`。 */
  readonly kind: ConflictKind
  readonly baseRevision: Revision | null
  readonly localRevision: Revision
  readonly remoteRevision: Revision
}

/** 合并决策。 */
export interface MergeDecision<T> {
  readonly action: MergeAction
  readonly reason: MergeReason
  /**
   * 契约层 `resolveConflict` 的原始裁决。
   *
   * 🔴 保留它是为了审计：任何"谁更新"的推断都能回溯到契约函数，
   * 而不是散落在业务代码里的比较。
   */
  readonly outcome: ConflictOutcome
  /** 需要写入本地实体的值；`null` = 保持本地现状。 */
  readonly value: T | null
  /** 需要写入的删除标志；`null` = 不改。 */
  readonly deleted: DeletedFlag | null
  /** `action === 'keep-both'` 时应落的冲突记录；否则 `null`。 */
  readonly conflict: MergeConflictFact | null
  /**
   * 远端**影子版本**。
   *
   * 🔴 只保存、不覆盖输入框（`07-同步协议与API.md`）。序列化成
   * `Conflict.remotePayload` 由仓储层负责，领域层不碰序列化。
   */
  readonly shadow: MergeVersion<T> | null
}

/** `mergeWithoutBase` / `threeWayMerge` 的可选行为开关。 */
export interface MergeOptions {
  /**
   * 无共同基线时是否直接采用远端（严格跟随 `resolveConflict` 的 `fast-forward`）。
   *
   * 默认 `false`：保守升级为 `keep-both`，避免清空未同步稿件。
   * 仅在调用方**确知**本地没有未推送改动（例如快照恢复后的纯拉取）时才置 `true`。
   */
  readonly adoptRemoteWhenNoBase?: boolean
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 无共同基线时的合并判定。
 *
 * 用于「本地没有该实体的基线记录，远端却有版本」的场景：首次同步、
 * 换机后恢复、游标过期后重放。因为没有祖先，**不可能做字段级合并**，
 * 结果只能是全有或全无。
 *
 * @param local 本地版本（含未推送稿件时务必保留默认保守行为）。
 * @param remote 远端版本。
 * @param options 见 `MergeOptions`。
 */
export function mergeWithoutBase<T>(
  local: MergeVersion<T>,
  remote: MergeVersion<T>,
  options: MergeOptions = {},
): MergeDecision<T> {
  return mergeVersions(null, local, remote, options)
}

/**
 * 三方合并判定：有共同基线时，能证明"只有一侧改了"就自动落地，
 * 否则保留双方版本。
 *
 * @param base 双方的共同祖先；调用方拿不到时请用 `mergeWithoutBase`。
 * @param local 本地当前版本。
 * @param remote 远端当前版本。
 * @param options 见 `MergeOptions`（对已提供基线的情形无影响）。
 */
export function threeWayMerge<T>(
  base: MergeVersion<T>,
  local: MergeVersion<T>,
  remote: MergeVersion<T>,
  options: MergeOptions = {},
): MergeDecision<T> {
  return mergeVersions(base, local, remote, options)
}

// ---------------------------------------------------------------------------
// 判定核心
// ---------------------------------------------------------------------------

function mergeVersions<T>(
  base: MergeVersion<T> | null,
  local: MergeVersion<T>,
  remote: MergeVersion<T>,
  options: MergeOptions,
): MergeDecision<T> {
  const baseRevision = base === null ? null : base.revision
  const outcome = resolveConflict({
    baseRevision,
    localRevision: local.revision,
    remoteRevision: remote.revision,
  })

  const localDeleted = isDeletedFlag(local.deleted)
  const remoteDeleted = isDeletedFlag(remote.deleted)

  // ---- 1. 两侧同一 revision：无事可做 -------------------------------------
  if (outcome.kind === 'already-current') {
    if (localDeleted && remoteDeleted) {
      return decide({
        action: 'already-current',
        reason: 'both-deleted',
        outcome,
        baseRevision,
        local,
        remote,
      })
    }
    return decide({ action: 'already-current', reason: 'identical-revision', outcome, baseRevision, local, remote })
  }

  // ---- 2. 删除语义：`resolveConflict` 看不到 tombstone，这一层补齐 ----------
  if (!localDeleted && remoteDeleted) {
    // 远端删除。本地自基线以来没动过 → 安全落地墓碑；动过 → 删除对编辑，显式冲突。
    if (base !== null && local.revision === base.revision) {
      return decide({ action: 'take-remote', reason: 'remote-deleted', outcome, baseRevision, local, remote })
    }
    return keepBoth(outcome, 'delete-vs-edit', baseRevision, local, remote)
  }

  if (localDeleted && !remoteDeleted) {
    // 本地删除、远端编辑：本地没改过就没得改，远端有编辑说明有人在写 → 冲突。
    if (base !== null && remote.revision === base.revision) {
      return decide({ action: 'keep-local', reason: 'local-deleted', outcome, baseRevision, local, remote })
    }
    return keepBoth(outcome, 'delete-vs-edit', baseRevision, local, remote)
  }

  if (localDeleted && remoteDeleted) {
    // 两侧都认为已删除：删除这件事本身没有分歧。
    return decide({ action: 'already-current', reason: 'both-deleted', outcome, baseRevision, local, remote })
  }

  // ---- 3. 两侧都存活：按 revision 关系决定能否自动快进 ----------------------
  if (base === null) {
    // 无共同祖先 → 无法证明改动不重叠。
    if (options.adoptRemoteWhenNoBase === true) {
      return decide({ action: 'take-remote', reason: 'no-common-base', outcome, baseRevision, local, remote })
    }
    return keepBoth(outcome, 'text-diverged', baseRevision, local, remote)
  }

  if (local.revision === remote.revision) {
    // 理论上已被 `already-current` 覆盖；留作显式兜底，避免 future 改动漏掉。
    return decide({ action: 'already-current', reason: 'identical-revision', outcome, baseRevision, local, remote })
  }

  if (remote.revision === base.revision) {
    // 远端自基线以来没变：本地领先，必须保留本地（推送由同步层负责）。
    return decide({ action: 'keep-local', reason: 'remote-unchanged', outcome, baseRevision, local, remote })
  }

  if (local.revision === base.revision) {
    // 本地自基线以来没变：采用远端是安全的。
    return decide({ action: 'take-remote', reason: 'local-unchanged', outcome, baseRevision, local, remote })
  }

  // 双方都在基线之上各自前进 → 契约已判 `conflict: diverged`。
  return keepBoth(outcome, 'text-diverged', baseRevision, local, remote)
}

// ---------------------------------------------------------------------------
// 决策构造
// ---------------------------------------------------------------------------

interface DecideInput<T> {
  readonly action: MergeAction
  readonly reason: MergeReason
  readonly outcome: ConflictOutcome
  readonly baseRevision: Revision | null
  readonly local: MergeVersion<T>
  readonly remote: MergeVersion<T>
  /** 仅 `action === 'keep-both'` 时需要。 */
  readonly kind?: ConflictKind
}

function decide<T>(input: DecideInput<T>): MergeDecision<T> {
  const { action, reason, outcome, baseRevision, local, remote, kind } = input

  if (action === 'take-remote') {
    return { action, reason, outcome, value: remote.value, deleted: remote.deleted, conflict: null, shadow: null }
  }

  if (action === 'keep-both') {
    if (kind === undefined) {
      throw new Error(`decide 内部错误：keep-both 必须带上冲突种类（reason=${reason}）`)
    }
    return {
      action,
      reason,
      outcome,
      value: null,
      deleted: null,
      conflict: {
        kind,
        baseRevision,
        localRevision: local.revision,
        remoteRevision: remote.revision,
      },
      // 影子版本始终保存：即使本次不采用，重试/比较时也要拿得到。
      shadow: remote,
    }
  }

  // already-current / keep-local：都不写本地实体。
  return { action, reason, outcome, value: null, deleted: null, conflict: null, shadow: null }
}

function keepBoth<T>(
  outcome: ConflictOutcome,
  kind: ConflictKind,
  baseRevision: Revision | null,
  local: MergeVersion<T>,
  remote: MergeVersion<T>,
): MergeDecision<T> {
  const reason: MergeReason =
    kind === 'delete-vs-edit' ? 'delete-vs-edit' : outcome.kind === 'conflict' ? 'diverged' : 'no-common-base'
  return decide({ action: 'keep-both', reason, outcome, baseRevision, local, remote, kind })
}

// ---------------------------------------------------------------------------
// 删除标志
// ---------------------------------------------------------------------------

/**
 * 软删除标志是否表示"已删除"。
 *
 * 🔴 一律用 `!== 0`，不要用真值判断：历史脏数据里可能出现非 0/1 的值
 * （见 `DeletedFlag` 契约注释），而 `NaN`/`undefined` 用真值判断会翻车。
 */
export function isDeletedFlag(flag: DeletedFlag): boolean {
  return flag !== 0
}

// ---------------------------------------------------------------------------
// 字段级变化分类
// ---------------------------------------------------------------------------

/**
 * 单个字段相对基线的变化归属。
 *
 * `07-同步协议与API.md`：字段三方合并**仅对定义过策略的字段生效**。
 * 本模块只负责分类，策略（取谁）由调用方的字段策略表决定。
 */
export type FieldChangeKind =
  /** 三方一致：任何一侧都是同一个值。 */
  | 'unchanged'
  /** 只有本地改过 → 取本地。 */
  | 'local-only'
  /** 只有远端改过 → 取远端。 */
  | 'remote-only'
  /** 两侧都改成了同一个值 → 结果唯一，不算冲突。 */
  | 'both-same'
  /** 两侧改成不同的值 → 必须按策略裁决或交给用户。 */
  | 'diverged'

/**
 * 判断一个字段相对基线的变化归属。
 *
 * @param equals 相等判定，默认 `Object.is`。
 *   🔴 对 `SettingsEntity.values` 这类记录结构请传入自己的结构比较器：
 *   `Object.is` 会把两个内容相同的对象判为"都改过"，从而**多报冲突**。
 *   这是刻意的保守默认——多报冲突只是多点一次，漏报冲突会丢数据。
 */
export function classifyFieldChange<T>(
  base: T,
  local: T,
  remote: T,
  equals: (a: T, b: T) => boolean = Object.is,
): FieldChangeKind {
  const localChanged = !equals(local, base)
  const remoteChanged = !equals(remote, base)

  if (!localChanged && !remoteChanged) return 'unchanged'
  if (localChanged && !remoteChanged) return 'local-only'
  if (!localChanged && remoteChanged) return 'remote-only'
  return equals(local, remote) ? 'both-same' : 'diverged'
}

/**
 * 按字段策略表挑出全部"必须保留双方"的字段名。
 *
 * 返回空数组即表示所有字段都能自动落地（配合 `classifyFieldChange` 使用）。
 */
export function divergedFields<T extends Record<string, unknown>>(
  base: Readonly<T>,
  local: Readonly<T>,
  remote: Readonly<T>,
  equals?: (a: unknown, b: unknown) => boolean,
): string[] {
  const names = new Set<string>([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
  const compare = (equals ?? Object.is) as (a: unknown, b: unknown) => boolean
  const result: string[] = []
  for (const name of names) {
    if (classifyFieldChange(base[name], local[name], remote[name], compare) === 'diverged') {
      result.push(name)
    }
  }
  return result.sort()
}
