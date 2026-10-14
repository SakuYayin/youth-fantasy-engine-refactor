/**
 * `@yfe/domain/merge` 契约测试。
 *
 * 这个模块不做正文自动合并——它只回答「远端变更能不能自动落地，还是必须保留双方版本」。
 * 因此测试的重点不是 happy path，而是**每一种可能丢数据的判定分支**：
 *
 * - 谁能自动落地（`take-remote`）、谁必须等推送（`keep-local`）、谁必须交给用户（`keep-both`）；
 * - `keep-both` 时**绝不能**写实体（`value`/`deleted` 必须是 `null`，否则等于偷偷覆盖用户的输入框）；
 * - 删除语义（墓碑）必须由本层补齐，因为 `resolveConflict` 只看 revision、看不到 `deleted`；
 * - 逐例断言 `outcome`（契约裁决）与本地动作的关系，任何「谁更新」的推断都必须能回溯到契约。
 */

import type { ConflictOutcome, DeletedFlag, Revision } from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import {
  classifyFieldChange,
  divergedFields,
  isDeletedFlag,
  mergeWithoutBase,
  threeWayMerge,
  type MergeDecision,
  type MergeVersion,
} from '../src/merge/index.js'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const rev = (value: string): Revision => value as Revision

/** 存活版本（`deleted: 0`）。 */
function alive<T>(revision: string, value: T): MergeVersion<T> {
  return { revision: rev(revision), deleted: 0, value }
}

/** 墓碑版本：`deleted` 存删除时间戳（非 0 即已删除）。 */
const TOMBSTONE = 1_760_000_000_000

function tomb<T>(revision: string, value: T): MergeVersion<T> {
  return { revision: rev(revision), deleted: TOMBSTONE, value }
}

/** `keep-both` 的核心安全断言：一个字节都不许写回本地实体。 */
function expectWritesNothing<T>(decision: MergeDecision<T>): void {
  expect(decision.value).toBeNull()
  expect(decision.deleted).toBeNull()
}

// ---------------------------------------------------------------------------
// threeWayMerge：两侧都存活
// ---------------------------------------------------------------------------

describe('threeWayMerge：两侧都存活', () => {
  it('远端自基线以来没变 → keep-local（本地领先，推送交给同步层）', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_4', '本地新写的正文')
    const remote = alive('rev_3', '基线正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-local')
    expect(decision.reason).toBe('remote-unchanged')
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'fast-forward' })
    expectWritesNothing(decision)
    expect(decision.conflict).toBeNull()
    expect(decision.shadow).toBeNull()
  })

  it('本地自基线以来没变 → take-remote（采用远端是安全的）', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_3', '基线正文')
    const remote = alive('rev_5', '远端新写的正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('take-remote')
    expect(decision.reason).toBe('local-unchanged')
    expect(decision.value).toBe('远端新写的正文')
    expect(decision.deleted).toBe(0)
    expect(decision.conflict).toBeNull()

    // 🔴 钉住一个反直觉事实：`resolveConflict` 只在 `base === remote` 时给 fast-forward，
    // `base === local`（本地未变、远端前进）它给的是 conflict:diverged。
    // 领域层之所以仍敢 take-remote，靠的是自己比较 `local.revision === base.revision`。
    // 谁要是把这里改成「严格照抄 outcome」，这个断言会立刻变红。
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'conflict', reason: 'diverged' })
  })

  it('双方各自前进 → keep-both，且只落冲突、不写实体', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_4', '本地正文')
    const remote = alive('rev_7', '远端正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('diverged')
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'conflict', reason: 'diverged' })
    expectWritesNothing(decision)
    expect(decision.conflict).toEqual({
      kind: 'text-diverged',
      baseRevision: rev('rev_3'),
      localRevision: rev('rev_4'),
      remoteRevision: rev('rev_7'),
    })
    // 影子版本必须始终保存：本次不采用，重试/比较时还要拿得到。
    expect(decision.shadow).toEqual(remote)
  })

  it('两侧同一 revision → already-current，什么都不做', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_8', '同一份正文')
    const remote = alive('rev_8', '同一份正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('already-current')
    expect(decision.reason).toBe('identical-revision')
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'already-current' })
    expectWritesNothing(decision)
    expect(decision.conflict).toBeNull()
    expect(decision.shadow).toBeNull()
  })

  it('绝不做 revision 大小比较：rev_9 → rev_10 / rev_2 仍判分歧', () => {
    // 若有人把「谁更新」写成字符串或数字比较，'rev_2' 会被当成最旧而误判为可快进。
    const base = alive('rev_9', '基线')
    const local = alive('rev_10', '本地')
    const remote = alive('rev_2', '远端')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('diverged')
    expectWritesNothing(decision)
  })
})

// ---------------------------------------------------------------------------
// threeWayMerge：删除语义（resolveConflict 看不到 tombstone）
// ---------------------------------------------------------------------------

describe('threeWayMerge：删除语义', () => {
  it('远端删除 + 本地自基线未变 → 安全落地墓碑', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_3', '基线正文')
    const remote = tomb('rev_4', '远端已删前的正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('take-remote')
    expect(decision.reason).toBe('remote-deleted')
    expect(decision.deleted).toBe(TOMBSTONE)
    expect(decision.value).toBe('远端已删前的正文')
    expect(decision.conflict).toBeNull()
  })

  it('远端删除 + 本地改过 → 删除对编辑，必须保留双方', () => {
    const base = alive('rev_3', '基线正文')
    const local = alive('rev_4', '本地刚写的正文')
    const remote = tomb('rev_5', '远端删除时的正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('delete-vs-edit')
    expectWritesNothing(decision)
    expect(decision.conflict).toMatchObject({
      kind: 'delete-vs-edit',
      baseRevision: rev('rev_3'),
      localRevision: rev('rev_4'),
      remoteRevision: rev('rev_5'),
    })
    expect(decision.shadow).toEqual(remote)
  })

  it('本地删除 + 远端自基线未变 → keep-local（远端没有新编辑）', () => {
    const base = alive('rev_3', '基线正文')
    const local = tomb('rev_4', '本地删除时的正文')
    const remote = alive('rev_3', '基线正文')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-local')
    expect(decision.reason).toBe('local-deleted')
    expectWritesNothing(decision)
    expect(decision.conflict).toBeNull()
  })

  it('本地删除 + 远端编辑 → 删除对编辑，必须保留双方', () => {
    const base = alive('rev_3', '基线正文')
    const local = tomb('rev_4', '本地删除时的正文')
    const remote = alive('rev_6', '远端又改了')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('delete-vs-edit')
    expect(decision.conflict).toMatchObject({ kind: 'delete-vs-edit' })
    expectWritesNothing(decision)
    expect(decision.shadow).toEqual(remote)
  })

  it('两侧都删除（revision 不同）→ 删除本身没有分歧，already-current', () => {
    const base = alive('rev_3', '基线正文')
    const local = tomb('rev_4', '本地删除')
    const remote = tomb('rev_6', '远端删除')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('already-current')
    expect(decision.reason).toBe('both-deleted')
    expectWritesNothing(decision)
    expect(decision.conflict).toBeNull()
  })

  it('两侧都删除且同一 revision → already-current', () => {
    const base = alive('rev_3', '基线正文')
    const local = tomb('rev_6', '本地删除')
    const remote = tomb('rev_6', '远端删除')

    const decision = threeWayMerge(base, local, remote)

    expect(decision.action).toBe('already-current')
    expect(decision.reason).toBe('both-deleted')
    expectWritesNothing(decision)
  })
})

// ---------------------------------------------------------------------------
// mergeWithoutBase
// ---------------------------------------------------------------------------

describe('mergeWithoutBase（无共同祖先）', () => {
  it('默认保守：宁可多保留一份，也不清空未同步稿件', () => {
    const local = alive('rev_1', '本地未推送的稿件')
    const remote = alive('rev_4', '远端正文')

    const decision = mergeWithoutBase(local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('no-common-base')
    expectWritesNothing(decision)
    expect(decision.conflict).toMatchObject({ kind: 'text-diverged', baseRevision: null })
    expect(decision.shadow).toEqual(remote)

    // 🔴 猛料：契约在这种情况下给的是 fast-forward（「远端是首个权威版本」），
    // 语义上「可以无冲突地向前推进」。领域层刻意**不**照抄，因为「本地是否有未推送改动」
    // 不在 resolveConflict 的入参里。这条断言就是那个刻意的分叉点。
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'fast-forward' })
  })

  it('调用方确知本地干净时可显式采纳远端', () => {
    const local = alive('rev_1', '本地')
    const remote = alive('rev_4', '远端')

    const decision = mergeWithoutBase(local, remote, { adoptRemoteWhenNoBase: true })

    expect(decision.action).toBe('take-remote')
    expect(decision.reason).toBe('no-common-base')
    expect(decision.value).toBe('远端')
    expect(decision.deleted).toBe(0)
    expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'fast-forward' })
  })

  it('两侧同一 revision → already-current（不受选项影响）', () => {
    const local = alive('rev_4', '同一份')
    const remote = alive('rev_4', '同一份')

    for (const options of [{}, { adoptRemoteWhenNoBase: true }]) {
      const decision = mergeWithoutBase(local, remote, options)
      expect(decision.action).toBe('already-current')
      expect(decision.reason).toBe('identical-revision')
      expect(decision.outcome).toEqual<ConflictOutcome>({ kind: 'already-current' })
      expectWritesNothing(decision)
    }
  })

  it('无基线时远端墓碑按「删除对编辑」处理，默认不落地', () => {
    const local = alive('rev_1', '本地正文')
    const remote = tomb('rev_4', '远端删除')

    const decision = mergeWithoutBase(local, remote)

    expect(decision.action).toBe('keep-both')
    expect(decision.reason).toBe('delete-vs-edit')
    expectWritesNothing(decision)
    expect(decision.conflict).toMatchObject({ kind: 'delete-vs-edit', baseRevision: null })

    // 🔴 `adoptRemoteWhenNoBase` **只管「两侧都存活」的无基线快进**（`src/merge/index.ts:248-253`）；
    // 远端墓碑 + 本地存活属于「删除对编辑」：没有共同祖先就证明不了本地干净，
    // 所以即使显式传了这个选项也必须给冲突（`src/merge/index.ts:226-231`）。
    // 这条断言是刻意钉死的：远端删除绝不能静默吞掉本地未同步的正文。
    const adopted = mergeWithoutBase(local, remote, { adoptRemoteWhenNoBase: true })
    expect(adopted.action).toBe('keep-both')
    expect(adopted.reason).toBe('delete-vs-edit')
    expectWritesNothing(adopted)

    // 对照：两侧都存活时该选项**才会**生效（严格采用契约的 fast-forward 语义）。
    const bothAlive = mergeWithoutBase(alive('rev_1', '本地'), alive('rev_4', '远端'), {
      adoptRemoteWhenNoBase: true,
    })
    expect(bothAlive.action).toBe('take-remote')
    expect(bothAlive.reason).toBe('no-common-base')

    // 不加选项时两侧存活也是保守的 keep-both。
    expect(mergeWithoutBase(alive('rev_1', '本地'), alive('rev_4', '远端')).action).toBe('keep-both')
  })
})

// ---------------------------------------------------------------------------
// isDeletedFlag
// ---------------------------------------------------------------------------

describe('isDeletedFlag', () => {
  it('0 是存活，非 0 是删除（含删除时间戳）', () => {
    expect(isDeletedFlag(0)).toBe(false)
    expect(isDeletedFlag(1)).toBe(true)
    expect(isDeletedFlag(TOMBSTONE)).toBe(true)
  })

  it('falsy 但非 0 的脏数据也算删除——所以绝不能用真值判断', () => {
    // 历史脏数据可能是 `''` 或 `NaN`。`flag ? 'deleted' : 'alive'` 会把它们当成存活，
    // 于是「已删除的文档」被当成活文档重新灌回编辑器。
    expect(isDeletedFlag('' as unknown as DeletedFlag)).toBe(true)
    expect(isDeletedFlag(Number.NaN)).toBe(true)
    expect(Boolean('')).toBe(false) // 对照：真值判断会翻车
  })
})

// ---------------------------------------------------------------------------
// classifyFieldChange / divergedFields
// ---------------------------------------------------------------------------

describe('classifyFieldChange', () => {
  it('五种归属各取其位', () => {
    expect(classifyFieldChange('a', 'a', 'a')).toBe('unchanged')
    expect(classifyFieldChange('a', 'b', 'a')).toBe('local-only')
    expect(classifyFieldChange('a', 'a', 'b')).toBe('remote-only')
    expect(classifyFieldChange('a', 'b', 'b')).toBe('both-same')
    expect(classifyFieldChange('a', 'b', 'c')).toBe('diverged')
  })

  it('默认 Object.is 对结构相同但引用不同的对象报 diverged（刻意的保守默认）', () => {
    const base = { level: 1 }
    const local = { level: 1 }
    const remote = { level: 1 }

    // 多报冲突只是多点一次；漏报冲突会丢数据。所以默认宁可报冲突。
    expect(classifyFieldChange(base, local, remote)).toBe('diverged')
  })

  it('传入结构比较器后，内容相同即为 both-same / unchanged', () => {
    const structural = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b)
    expect(classifyFieldChange({ level: 1 }, { level: 1 }, { level: 1 }, structural)).toBe('unchanged')
    expect(classifyFieldChange({ level: 1 }, { level: 2 }, { level: 2 }, structural)).toBe('both-same')
    expect(classifyFieldChange({ level: 1 }, { level: 2 }, { level: 1 }, structural)).toBe('local-only')
  })
})

describe('divergedFields', () => {
  it('只挑出 diverged 的字段名，排序后返回', () => {
    const base = { title: '旧标题', summary: '旧摘要', tags: '旧标签' }
    const local = { title: '本地标题', summary: '旧摘要', tags: '本地标签' }
    const remote = { title: '旧标题', summary: '远端摘要', tags: '远端标签' }

    // title 只有本地改（local-only）、summary 只有远端改（remote-only）→ 都能自动落地；
    // 只有 tags 两侧都改且不同 → 必须保留双方。
    expect(divergedFields(base, local, remote)).toEqual(['tags'])
  })

  it('字段只出现在其中一侧 → 只算 local-only / remote-only，不进候选集合', () => {
    const base: Record<string, unknown> = { title: '基线' }
    const local: Record<string, unknown> = { title: '基线', endedAt: '2026-10-15' }
    const remote: Record<string, unknown> = { title: '基线', startedAt: '2026-10-01' }

    // 缺字段按 `undefined` 参与比较：只有一侧变化 → 能自动落地，不是"必须保留双方"。
    expect(divergedFields(base, local, remote)).toEqual([])

    // 对照：同一字段两侧都改了且值不同 → 才是候选。
    const onlyTitle: Record<string, unknown> = { title: '基线' }
    const localEnded: Record<string, unknown> = { title: '基线', endedAt: '2026-10-15' }
    const remoteEndedOther: Record<string, unknown> = { title: '基线', endedAt: '2026-10-16' }
    expect(divergedFields(onlyTitle, localEnded, remoteEndedOther)).toEqual(['endedAt'])

    // 两侧都新增同一个字段且值相同 → `both-same`，结果唯一，也不算冲突。
    const remoteEndedSame: Record<string, unknown> = { title: '基线', endedAt: '2026-10-15' }
    expect(divergedFields(onlyTitle, localEnded, remoteEndedSame)).toEqual([])
  })

  it('传自定义 equals 时嵌套对象不误报', () => {
    const structural = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    const base = { values: { level: 1, note: '旧' } }
    const local = { values: { level: 1, note: '旧' } }
    const remote = { values: { level: 1, note: '旧' } }

    expect(divergedFields(base, local, remote, structural)).toEqual([])
    expect(divergedFields(base, local, remote)).toEqual(['values']) // 默认 Object.is 会报冲突
  })
})
