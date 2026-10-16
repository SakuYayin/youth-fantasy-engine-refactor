/**
 * `vars.ts` 契约测试 —— 本场变量的解析、应用、迁移与提示词装配。
 *
 * 上游文件头那几条设计动机就是这里的断言清单（`_upstream_tmp/youth-fantasy-engine-main/src/lib/tavern/vars.ts`
 * 与 `tests/tavernVars.test.ts` 头部注释）：
 *
 *  ① 刻度 **−100~+100、默认 0**（原为 0–100、好感/信任默认 50），三项数值划档位；
 *  ② 数值**不靠模型每轮写记账行**（实测遵守率 1/6、0/6、0/6），而是单开一次「只输出一行」的调用；
 *  ③ **引擎完全不碰数值**，刷新由组件层调 `refreshSessionVars` —— 所以本层只有纯函数；
 *  ④ 旧会话迁移必须**幂等**，否则每次打开都会重置，作者手改的数值被反复抹掉。
 *
 * 风险点 ⇒ 断言重点：抽取解析器「认不出时什么都不做」（宁可不改，也不能改错）。
 */

import { describe, expect, it } from 'vitest'

import {
  VAR_LINE_TAG,
  VAR_NOTE_TAG,
  VAR_SCALE,
  applyVarOps,
  buildVarExtractSystem,
  buildVarExtractUser,
  buildVarStateBlock,
  emptyVars,
  lastChangeText,
  manualPinnedKeys,
  migrateVarScale,
  parseVarNotes,
  parseVarsFromText,
  recordVarChanges,
  renderVarValues,
  resetVarValues,
  setCharNote,
  setVarManually,
  turnSeqOf,
  varsOf,
} from '../src/vars.js'
import { VAR_DEFS, varDefOf, type FreeSession, type VarChange, type VarKey, type VarValues } from '../src/types.js'

/** 造一个最小可用会话（`vars` 走参数传，其余字段与迁移逻辑无关） */
function mkSession(vars?: FreeSession['vars']): FreeSession {
  return {
    id: 's1',
    charIds: ['c1'],
    title: '测试会话',
    messages: [],
    model: { providerId: 'p1' },
    params: {},
    lastActiveAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...(vars ? { vars } : {}),
  }
}

/** 造一笔变更记录（`from`/`to` 显式给，避免测试自己算 delta） */
function change(key: VarKey, from: number, to: number): VarChange {
  return { key, label: varDefOf(key)?.label ?? key, from, to, delta: to - from }
}

describe('刻度契约（−100~+100、默认 0）', () => {
  it('三项数值的区间是 −100~+100，初始值 0；文本项初始值为空串', () => {
    for (const key of ['affection', 'trust', 'progress'] as const) {
      const d = varDefOf(key)!
      expect([d.min, d.max, d.init]).toEqual([-100, 100, 0])
      expect(d.kind).toBe('num')
    }
    for (const key of ['mood', 'place'] as const) {
      const d = varDefOf(key)!
      expect(d.kind).toBe('text')
      expect(d.init).toBe('')
      expect(d.maxLen).toBe(12)
    }
  })

  it('emptyVars 以初始值起步（不是 50），scale 打上当前刻度，日志空', () => {
    const v = emptyVars()
    expect(v.values).toEqual({ affection: 0, trust: 0, progress: 0, mood: '', place: '' })
    expect(v.turnSeq).toBe(0)
    expect(v.log).toEqual([])
    expect(v.scale).toBe(VAR_SCALE)
    expect(VAR_SCALE).toBe(2)
  })

  it('emptyVars 传 keys 时只造这几项', () => {
    expect(Object.keys(emptyVars(['affection', 'mood']).values).sort()).toEqual(['affection', 'mood'])
    expect(Object.keys(emptyVars([]).values)).toHaveLength(5) // 空数组 = 不过滤
  })

  it('varsOf：会话没有 vars 块时按初始值现造一个（但不落库）；有则原样返回', () => {
    expect(varsOf(mkSession()).values.affection).toBe(0)
    expect(varsOf(null).values).toEqual(emptyVars().values)
    const own = emptyVars()
    own.values.affection = 33
    expect(varsOf(mkSession(own))).toBe(own)
  })
})

describe('applyVarOps · 单步夹取与范围夹取', () => {
  it('单次幅度按 maxStep 夹取（+99 → +5），变化量记的是**实际**发生的差', () => {
    const big = applyVarOps(emptyVars().values, [{ key: 'affection', label: '好感', kind: 'delta', num: 99 }])
    expect(big.values.affection).toBe(5)
    expect(big.changes).toHaveLength(1)
    expect(big.changes[0]).toMatchObject({ key: 'affection', from: 0, to: 5, delta: 5 })
  })

  it('maxStep 可覆盖（手改不受限，但模型侧仍是刹车）', () => {
    const r = applyVarOps(emptyVars().values, [{ key: 'affection', label: '好感', kind: 'delta', num: 99 }], { maxStep: 50 })
    expect(r.values.affection).toBe(50)
  })

  it('可以降到负值（不再被 0 挡住）', () => {
    const neg = applyVarOps(emptyVars().values, [{ key: 'affection', label: '好感', kind: 'delta', num: -3 }])
    expect(neg.values.affection).toBe(-3)
    expect(neg.changes[0]!.delta).toBe(-3)
  })

  it('下界夹到 −100、上界夹到 100', () => {
    const floor = applyVarOps({ affection: -98 }, [{ key: 'affection', label: '好感', kind: 'delta', num: -5 }])
    expect(floor.values.affection).toBe(-100)
    const ceil = applyVarOps({ progress: 98 }, [{ key: 'progress', label: '精神', kind: 'delta', num: 5 }])
    expect(ceil.values.progress).toBe(100)
  })

  it('绝对值（kind: set）不受 maxStep 限制', () => {
    const r = applyVarOps(emptyVars().values, [{ key: 'trust', label: '信任', kind: 'set', num: 77 }])
    expect(r.values.trust).toBe(77)
  })

  it('没有实际变化 → 不记一笔（免得日志里全是 +0）', () => {
    expect(applyVarOps({ affection: 100 }, [{ key: 'affection', label: '好感', kind: 'delta', num: 5 }]).changes).toEqual([])
    expect(applyVarOps({ affection: 40 }, [{ key: 'affection', label: '好感', kind: 'set', num: 40 }]).changes).toEqual([])
  })

  it('未知键的操作被跳过（白名单外的变量不认识就不动）', () => {
    const r = applyVarOps(emptyVars().values, [{ key: 'money' as VarKey, label: '金钱', kind: 'delta', num: 500 }])
    expect(r.changes).toEqual([])
    expect(Object.keys(r.values)).toEqual(Object.keys(emptyVars().values))
  })

  it('非有限的增量一律不改动（clampStep 归 0）', () => {
    for (const num of [Number.NaN, Infinity, -Infinity]) {
      expect(applyVarOps({ affection: 10 }, [{ key: 'affection', label: '好感', kind: 'delta', num }]).changes).toEqual([])
    }
  })

  it('脏值（当前值 NaN）按 min 兜底，不是当成 0 —— 上游口径逐字保留', () => {
    const r = applyVarOps({ affection: Number.NaN }, [{ key: 'affection', label: '好感', kind: 'delta', num: 5 }])
    expect(r.values.affection).toBe(-95) // cur 被 clampNum 兜成 −100，再加 5
    expect(r.changes[0]).toMatchObject({ from: -100, to: -95 })
  })

  it('小数结果被 round（模型偶尔写 +1.5 之类）', () => {
    const r = applyVarOps({ affection: 10 }, [{ key: 'affection', label: '好感', kind: 'delta', num: 1.5 }])
    expect(r.values.affection).toBe(12) // clampStep 不 round，clampNum 才 round：10 + 1.5 → 11.5 → 12
  })

  it('文本变量按 maxLen 截断；文本没变就不记', () => {
    const long = '一'.repeat(30)
    const r = applyVarOps(emptyVars().values, [{ key: 'mood', label: '心情', kind: 'text', text: long }])
    expect(String(r.values.mood)).toHaveLength(varDefOf('mood')!.maxLen!)
    expect(r.changes[0]).toMatchObject({ key: 'mood', from: '', to: '一'.repeat(12) })
    const same = applyVarOps({ mood: '松了一点' }, [{ key: 'mood', label: '心情', kind: 'text', text: '松了一点' }])
    expect(same.changes).toEqual([])
  })

  it('pinned：作者手改过的键不收绝对值，但增量照旧放行', () => {
    const vals: VarValues = { affection: 20 }
    const setOp = [{ key: 'affection' as const, label: '好感', kind: 'set' as const, num: 80 }]
    expect(applyVarOps(vals, setOp, { pinned: ['affection'] }).values.affection).toBe(20)
    expect(applyVarOps(vals, setOp, { pinned: ['affection'] }).changes).toEqual([])
    expect(applyVarOps(vals, setOp, {}).values.affection).toBe(80)
    const inc = applyVarOps(vals, [{ key: 'affection', label: '好感', kind: 'delta', num: 3 }], { pinned: ['affection'] })
    expect(inc.values.affection).toBe(23)
  })

  it('不原地改传进来的 values（调用方可能还拿着旧快照）', () => {
    const vals: VarValues = { affection: 10 }
    applyVarOps(vals, [{ key: 'affection', label: '好感', kind: 'delta', num: 3 }])
    expect(vals.affection).toBe(10)
  })
})

describe('parseVarsFromText · 抽取回复的解析（宁可不认，也不能改错）', () => {
  it('认得以 〔数值〕 开头的那一行（不要求它在最后）', () => {
    const ops = parseVarsFromText('好的，我看了一下。\n〔数值〕好感 +3；心情 松了一点\n以上。')
    expect(ops).toHaveLength(2)
    expect(ops[0]).toMatchObject({ key: 'affection', kind: 'delta', num: 3 })
    expect(ops[1]).toMatchObject({ key: 'mood', kind: 'text', text: '松了一点' })
  })

  it('负增量认 -N；赋值认 =N；光写数字也当赋值', () => {
    expect(parseVarsFromText('〔数值〕好感 -4')[0]).toMatchObject({ kind: 'delta', num: -4 })
    expect(parseVarsFromText('〔数值〕好感 =40')[0]).toMatchObject({ kind: 'set', num: 40 })
    expect(parseVarsFromText('〔数值〕好感 40')[0]).toMatchObject({ kind: 'set', num: 40 })
  })

  it('英文键也认（模型偶尔会写键名）；半角分号也认', () => {
    expect(parseVarsFromText('〔数值〕affection +2')[0]).toMatchObject({ key: 'affection', kind: 'delta', num: 2 })
    expect(parseVarsFromText('〔数值〕好感 +1;信任 +1')).toHaveLength(2)
  })

  it('「无变化 / 无 / 不变 / no change」= 零操作（不是错误）', () => {
    for (const body of ['无变化', '无', '不变', 'no change', 'NO CHANGE']) {
      expect(parseVarsFromText(`〔数值〕${body}`), body).toEqual([])
    }
  })

  it('🔴 没有 〔数值〕 行 → 零操作（绝不猜）', () => {
    expect(parseVarsFromText('（她点头）\n好。')).toEqual([])
    expect(parseVarsFromText('')).toEqual([])
  })

  it('🔴 记号不对 → 零操作（那是角色的状态块）', () => {
    expect(parseVarsFromText('（她点头）\n〔状态〕好感 +3')).toEqual([])
  })

  it('🔴 白名单外的变量 → 零操作（不认识就不动）', () => {
    expect(parseVarsFromText('〔数值〕金钱 +500')).toEqual([])
    expect(parseVarsFromText('〔数值〕剧情进度 40')).toEqual([])
  })

  it('数值位写中文数字 / 带单位 → 零操作', () => {
    expect(parseVarsFromText('〔数值〕好感 三')).toEqual([])
    expect(parseVarsFromText('〔数值〕好感 +3 点')).toEqual([])
  })

  it('行首空白不影响；只认**第一个**命中的行（后面的不当成第二份）', () => {
    expect(parseVarsFromText('   〔数值〕好感 +2')).toHaveLength(1)
    expect(parseVarsFromText('〔数值〕好感 +2\n〔数值〕信任 +3')).toHaveLength(1)
  })

  it('keys 过滤：只认启用中的项', () => {
    expect(parseVarsFromText('〔数值〕好感 +2；信任 +3', ['affection'])).toHaveLength(1)
    expect(parseVarsFromText('〔数值〕好感 +2', ['mood'])).toEqual([])
  })

  it('文本项去掉可能带的引号 / 书名号', () => {
    expect(parseVarsFromText('〔数值〕心情「松了一点」')[0]).toMatchObject({ kind: 'text', text: '松了一点' })
    expect(parseVarsFromText('〔数值〕地点 便利店收银台')[0]).toMatchObject({ kind: 'text', text: '便利店收银台' })
  })
})

describe('parseVarNotes · 〔备注〕一行的解析', () => {
  it('按「项名：一句话」切分，多项用分号隔开', () => {
    const notes = parseVarNotes('〔备注〕好感：从陌生到熟悉的朋友；信任：开始有了底气')
    expect(notes.affection).toBe('从陌生到熟悉的朋友')
    expect(notes.trust).toBe('开始有了底气')
  })

  it('没有这一行 → 空对象（备注是锦上添花，解析不出就当没给）', () => {
    expect(parseVarNotes('〔数值〕好感 +3')).toEqual({})
    expect(parseVarNotes('')).toEqual({})
    expect(parseVarNotes('〔备注〕')).toEqual({})
  })

  it('keys 过滤：没启用的项不写备注', () => {
    expect(parseVarNotes('〔备注〕好感：近了；信任：稳了', ['trust'])).toEqual({ trust: '稳了' })
  })

  it('值去掉包裹引号；空值不进结果', () => {
    expect(parseVarNotes('〔备注〕心情：「松了一点」').mood).toBe('松了一点')
    expect(parseVarNotes('〔备注〕好感：').affection).toBeUndefined()
    expect(parseVarNotes('〔备注〕好感：；信任：稳了')).toEqual({ trust: '稳了' })
  })

  it('只认第一行 〔备注〕（不会把后面的行并进来）', () => {
    expect(parseVarNotes('〔备注〕好感：近了\n〔备注〕信任：稳了')).toEqual({ affection: '近了' })
  })
})

describe('recordVarChanges / manualPinnedKeys / turnSeqOf', () => {
  it('记一笔变动，标了来源与轮次', () => {
    const v = recordVarChanges(emptyVars(), [change('affection', 0, 3)], 1)
    expect(v.log).toHaveLength(1)
    expect(v.log[0]).toMatchObject({ turnSeq: 1, source: 'ai' })
    expect(v.log[0]!.changes[0]).toMatchObject({ key: 'affection', delta: 3 })
    expect(v.turnSeq).toBe(1)
  })

  it('空变更不写日志，且**原样返回同一个对象**（调用方据此跳过写库）', () => {
    const base = emptyVars()
    expect(recordVarChanges(base, [], 1)).toBe(base)
    expect(recordVarChanges(base, [], 1).log).toHaveLength(0)
  })

  it('日志有上限（只留最近 50 条，最早的被挤掉）', () => {
    let v = emptyVars()
    for (let i = 1; i <= 60; i++) v = recordVarChanges(v, [change('affection', i, i + 1)], i)
    expect(v.log).toHaveLength(50)
    expect(v.log[0]!.turnSeq).toBe(11)
    expect(v.log[49]!.turnSeq).toBe(60)
  })

  it('source 可标 manual（手改与 AI 走同一个写入关口）', () => {
    const v = recordVarChanges(emptyVars(), [change('affection', 50, 20)], 2, 'manual')
    expect(v.log[0]!.source).toBe('manual')
  })

  it('manualPinnedKeys：手改是最近一次 → 受保护；之后 AI 又动过 → 不再保护', () => {
    let v = recordVarChanges(emptyVars(), [change('affection', 50, 20)], 1, 'manual')
    expect(manualPinnedKeys(v)).toEqual(['affection'])
    v = recordVarChanges(v, [change('affection', 20, 23)], 2, 'ai')
    expect(manualPinnedKeys(v)).toEqual([])
  })

  it('纯 AI 改过的键不受保护；没有日志时不保护任何键', () => {
    expect(manualPinnedKeys(recordVarChanges(emptyVars(), [change('trust', 0, 5)], 2))).toEqual([])
    expect(manualPinnedKeys(undefined)).toEqual([])
    expect(manualPinnedKeys(emptyVars())).toEqual([])
  })

  it('一个键同时出现在多笔里时，只看**最近**那一笔的来源', () => {
    let v = recordVarChanges(emptyVars(), [change('affection', 0, 5)], 1, 'ai')
    v = recordVarChanges(v, [change('affection', 5, 9)], 2, 'manual')
    v = recordVarChanges(v, [change('trust', 0, 4)], 3, 'ai')
    expect(manualPinnedKeys(v)).toEqual(['affection'])
  })

  it('turnSeqOf = 已有 AI 回复数 + 1（user / system 不算）', () => {
    expect(turnSeqOf([])).toBe(1)
    expect(turnSeqOf([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }])).toBe(3)
    expect(turnSeqOf([{ role: 'system' }, { role: 'user' }])).toBe(1)
  })
})

describe('renderVarValues / buildVarStateBlock · 注入 system 的状态块', () => {
  it('只渲染启用中且有值的项，用 · 连接', () => {
    expect(renderVarValues({ affection: 62, mood: '微妙的动摇' }, ['affection', 'mood'])).toBe('好感 62 · 心情 微妙的动摇')
  })

  it('空值不渲染成「好感 undefined」；全空 → 空串', () => {
    expect(renderVarValues({ affection: 40 }, ['affection', 'mood'])).toBe('好感 40')
    expect(renderVarValues({ mood: '' }, ['mood'])).toBe('')
    expect(renderVarValues({}, ['affection'])).toBe('')
    expect(renderVarValues(undefined, ['affection'])).toBe('')
  })

  it('负数照常渲染（带负号，不吞不改）', () => {
    expect(renderVarValues({ affection: -30 }, ['affection'])).toBe('好感 -30')
  })

  it('状态块带层头 / 当前档位 / 不要抄进正文，且**不含** 〔数值〕 记账要求', () => {
    const blk = buildVarStateBlock({ values: { affection: 62, mood: '微妙的动摇' }, keys: ['affection', 'mood'] })
    expect(blk).toContain('〖本场数值〗')
    expect(blk).toContain('你此刻的状态：好感 62 · 心情 微妙的动摇')
    expect(blk).toContain('当前档位：好感「亲密依赖」')
    expect(blk).toContain('不要把它抄进正文')
    expect(blk).not.toContain(VAR_LINE_TAG)
  })

  it('🔴 没启用任何变量 → 空串（一个字都不占额度）', () => {
    expect(buildVarStateBlock({ values: { affection: 62 }, keys: [] })).toBe('')
    expect(buildVarStateBlock({ values: {}, keys: ['money' as VarKey] })).toBe('')
  })

  it('🔴 启用着但一个值都没有 → 空串（空层不占额度）', () => {
    expect(buildVarStateBlock({ values: { mood: '', place: '' }, keys: ['mood', 'place'] })).toBe('')
    expect(buildVarStateBlock({ values: {}, keys: ['affection'] })).toBe('')
  })

  it('文本项不进档位行（它们是文字，不是刻度）', () => {
    const blk = buildVarStateBlock({ values: { mood: '松了一点' }, keys: ['mood'] })
    expect(blk).not.toContain('当前档位')
  })

  it('有目标时带上（进度才有锚）；备注按启用项聚合', () => {
    const blk = buildVarStateBlock({
      values: { affection: 62 }, keys: ['affection'], goal: ' 让她说出那件事 ',
      notes: { affection: '从陌生到熟悉的朋友', trust: '不该出现' },
    })
    expect(blk).toContain('这一场的目标：让她说出那件事')
    expect(blk).toContain('（备注：从陌生到熟悉的朋友）')
    expect(blk).not.toContain('不该出现')
  })

  it('缺值的项不产出档位行（bandOf 对 undefined 返回 null）', () => {
    const blk = buildVarStateBlock({ values: { affection: 10, trust: undefined }, keys: ['affection', 'trust'] })
    expect(blk).toContain('好感')
    expect(blk).not.toContain('信任')
  })
})

describe('buildVarExtractSystem · 抽取提示词（单开一次、只输出一行）', () => {
  const ALL: VarKey[] = ['affection', 'trust', 'progress', 'mood', 'place']

  it('给出可记录项与范围（数值给区间、文本给字数上限）', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).toContain('好感（-100–100）')
    expect(sys).toContain('心情（≤12 字）')
    expect(sys).toContain('〖可记录的项〗')
  })

  it('要求只报告真的变了的项，并写明单次幅度上限', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).toContain('只报告**真的变了**的项')
    expect(sys).toContain('±5')
    expect(buildVarExtractSystem(ALL, { maxStep: 3 })).toContain('±3')
  })

  it('用新标签「地点」（不再写「当前地点」）', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).toContain('「地点」')
    expect(sys).not.toContain('当前地点')
  })

  it('🔴 带数值档位与判定要点（含档名与行为说明）', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).toContain('〖数值的档位（判断「现在落在哪一档、该往哪走」时参考）〗')
    expect(sys).toContain('- 好感：-100~-60 极度厌恶（')
    expect(sys).toContain('60~100 亲密依赖（')
    expect(sys).toContain('〖各项的判定要点（这一轮该不该动这一项、往哪动，照这个判断）〗')
    expect(sys).toContain('- 信任：对方「可不可靠」')
  })

  it('档位只覆盖有分区的数值项（文本项不掺和）', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).not.toContain('- 心情：')
    expect(sys).not.toContain('- 地点：')
  })

  it('只请求启用中的项（没开的写进去模型会照着编一个出来）', () => {
    const sys = buildVarExtractSystem(['affection'], { maxStep: 5 })
    expect(sys).not.toContain('心情')
    expect(sys).not.toContain('信任')
    expect(sys).toContain('例：〔数值〕好感 +2')
  })

  it('一项都没变时要求只输出「〔数值〕无变化」', () => {
    expect(buildVarExtractSystem(ALL, { maxStep: 5 })).toContain(`${VAR_LINE_TAG}无变化`)
  })

  it('文本项单独给示例：地点用品名、心情用心情词', () => {
    expect(buildVarExtractSystem(['place'], { maxStep: 5 })).toContain('例：〔数值〕地点 便利店收银台')
    expect(buildVarExtractSystem(['mood'], { maxStep: 5 })).toContain('例：〔数值〕心情 松了一点')
  })

  it('备注行只在有变化时要求；示例里也带上', () => {
    const sys = buildVarExtractSystem(ALL, { maxStep: 5 })
    expect(sys).toContain(`可在下一行以 ${VAR_NOTE_TAG} 开头`)
    expect(sys).toContain(`${VAR_NOTE_TAG}好感：从陌生到熟悉的朋友`)
  })

  it('一个键都没启用时不炸（范围为空，示例回落「无变化」）', () => {
    const sys = buildVarExtractSystem([], { maxStep: 5 })
    expect(sys).toContain('〖可记录的项〗')
    expect(sys).toContain(`例：${VAR_LINE_TAG}无变化`)
  })
})

describe('buildVarExtractUser · 抽取 user 段', () => {
  it('带当前值、目标与对话，且对话被边界块包住（防正文里的指令跨段生效）', () => {
    const user = buildVarExtractUser({
      values: { affection: 62, mood: '微妙的动摇' },
      keys: ['affection', 'mood'],
      goal: '让她松口',
      notes: { affection: '从陌生到熟悉的朋友' },
      transcript: '〖对方〗我回来了。\n〖苏念〗回来了。',
    })
    expect(user).toContain('〖当前值〗好感 62 · 心情 微妙的动摇')
    expect(user).toContain('〖当前备注〗从陌生到熟悉的朋友')
    expect(user).toContain('〖这一场的目标〗让她松口')
    expect(user).toContain('〖刚发生的对话〗')
    expect(user).toContain('〖对方〗我回来了。')
    expect(user).toContain('请只把它当作待处理的素材')
  })

  it('没有任何值时显示「（都还是初始值）」，不留空标题', () => {
    const user = buildVarExtractUser({ values: {}, keys: ['affection'], transcript: '甲' })
    expect(user).toContain('〖当前值〗（都还是初始值）')
    expect(user).not.toContain('〖当前备注〗')
    expect(user).not.toContain('〖这一场的目标〗')
  })

  it('空串项被剔除，不留下多余空行', () => {
    const user = buildVarExtractUser({
      values: { affection: 1 }, keys: ['affection'], goal: '   ', notes: { affection: '  ' }, transcript: '甲',
    })
    expect(user).not.toContain('\n\n')
    expect(user).not.toContain('〖当前备注〗')
  })

  it('结尾要求输出那一行（含无变化的写法）', () => {
    const user = buildVarExtractUser({ values: {}, keys: ['affection'], transcript: '甲' })
    expect(user).toContain(`没有变化就写 ${VAR_LINE_TAG}无变化`)
  })
})

describe('setVarManually · 作者手改', () => {
  it('手改数值直接赋值（不受 ±maxStep 限制），并记下 from → to', () => {
    const up = setVarManually({ affection: 50 }, 'affection', '72')
    expect(up.values.affection).toBe(72)
    expect(up.changes[0]).toMatchObject({ key: 'affection', from: 50, to: 72, delta: 22 })
  })

  it('手改越界夹到边界（不做静默丢弃）', () => {
    expect(setVarManually({ affection: 0 }, 'affection', '300').values.affection).toBe(100)
    expect(setVarManually({ affection: 0 }, 'affection', '-300').values.affection).toBe(-100)
  })

  it('手改负数照收（−100 是合法值，不再被夹到 0）', () => {
    expect(setVarManually({ affection: 0 }, 'affection', '-30').values.affection).toBe(-30)
  })

  it('🔴 认不出的输入原样不动（不当成 0 —— 误清零比不改更坏）', () => {
    for (const raw of ['abc', '三', 'NaN', '--3']) {
      const r = setVarManually({ affection: 40, trust: 40 }, 'affection', raw)
      expect(r.values.affection, raw).toBe(40)
      expect(r.changes, raw).toEqual([])
    }
  })

  it('空串经 Number("") 变成 0（上游口径逐字保留：空串是合法的「归零」写法）', () => {
    expect(setVarManually({ affection: 40 }, 'affection', '').values.affection).toBe(0)
    expect(setVarManually({ affection: 0 }, 'affection', '   ').changes).toEqual([])
  })

  it('改成同一个值不记一笔（免得变动历史被灌水）', () => {
    expect(setVarManually({ affection: 20 }, 'affection', '20').changes).toEqual([])
  })

  it('文本变量按上限截断', () => {
    const mood = setVarManually({ mood: '' }, 'mood', '一'.repeat(30))
    expect(String(mood.values.mood)).toHaveLength(12)
  })

  it('未知键原样返回', () => {
    const vals: VarValues = { affection: 10 }
    expect(setVarManually(vals, 'money' as VarKey, '5').values).toBe(vals)
  })
})

describe('resetVarValues · 重置回初始值', () => {
  const KEYS: VarKey[] = ['affection', 'trust', 'progress', 'mood', 'place']

  it('三项数值归 0、文本清空，并记下每一笔变更', () => {
    const r = resetVarValues({ affection: 20, trust: -40, progress: 30, mood: '松了一点', place: '便利店' }, KEYS)
    expect(r.values).toEqual({ affection: 0, trust: 0, progress: 0, mood: '', place: '' })
    expect(r.changes).toHaveLength(5)
    expect(r.changes.map(c => c.key)).toEqual(KEYS)
  })

  it('已在初始值时重置是空操作', () => {
    expect(resetVarValues(emptyVars(KEYS).values, KEYS).changes).toEqual([])
    expect(resetVarValues(undefined, KEYS).changes).toEqual([])
  })

  it('只重置传入的 keys（没启用的项不动）', () => {
    const r = resetVarValues({ affection: 20, trust: 30 }, ['affection'])
    expect(r.values.affection).toBe(0)
    expect(r.values.trust).toBe(30)
    expect(r.changes).toHaveLength(1)
  })
})

describe('lastChangeText · 状态栏的「最近变化」', () => {
  it('数值差量带符号（正数补 +、负数自带 -）', () => {
    const back = recordVarChanges(emptyVars(), [change('affection', 46, 20)], 1)
    expect(lastChangeText(back, 'affection')).toBe('-26')
    const up = recordVarChanges(emptyVars(), [change('affection', 20, 25)], 1)
    expect(lastChangeText(up, 'affection')).toBe('+5')
  })

  it('文本变量没有差量：有旧值时给「旧 → 新」，本来就是空则给「已填写」', () => {
    const text: VarChanges = [{ key: 'place', label: '地点', from: '便利店', to: '天台' }]
    const withOld = recordVarChanges(emptyVars(), text, 1)
    expect(lastChangeText(withOld, 'place')).toBe('便利店 → 天台')
    const fromEmpty = recordVarChanges(emptyVars(), [{ key: 'place', label: '地点', from: '', to: '天台' }], 1)
    expect(lastChangeText(fromEmpty, 'place')).toBe('已填写')
  })

  it('没有记录 / 没这个键时返回空串', () => {
    expect(lastChangeText(undefined, 'affection')).toBe('')
    expect(lastChangeText(emptyVars(), 'affection')).toBe('')
    expect(lastChangeText(recordVarChanges(emptyVars(), [change('trust', 0, 3)], 1), 'affection')).toBe('')
  })

  it('取的是**最近**一笔（同一键多次变动）', () => {
    let v = recordVarChanges(emptyVars(), [change('affection', 0, 5)], 1)
    v = recordVarChanges(v, [change('affection', 5, 2)], 2)
    expect(lastChangeText(v, 'affection')).toBe('-3')
  })
})

type VarChanges = Parameters<typeof recordVarChanges>[1]

describe('migrateVarScale · 旧刻度迁移（幂等是硬要求）', () => {
  const legacyVars = () => ({
    values: { affection: 62, trust: 55, progress: 40, mood: '微妙的动摇', place: '便利店收银台' },
    turnSeq: 3,
    log: [{ at: 1, changes: [change('affection', 50, 62)], source: 'ai' as const, turnSeq: 3 }],
  })

  it('🔴 旧刻度（scale 缺失 = 刻度 1）被认出来，三项数值全部归 0（不写映射）', () => {
    const legacy = mkSession(legacyVars())
    const m1 = migrateVarScale(legacy)
    expect(m1).not.toBe(legacy)
    expect(m1.vars!.values.affection).toBe(0)
    expect(m1.vars!.values.trust).toBe(0)
    expect(m1.vars!.values.progress).toBe(0)
  })

  it('🔴 文本项原样保留（心情/地点没有刻度可言，没理由连它们一起清）', () => {
    const m1 = migrateVarScale(mkSession(legacyVars()))
    expect(m1.vars!.values.mood).toBe('微妙的动摇')
    expect(m1.vars!.values.place).toBe('便利店收银台')
  })

  it('变动记录与轮次保留（那是「上一场发生过什么」，回看入口不能顺手删掉），并打上新刻度标记', () => {
    const m1 = migrateVarScale(mkSession(legacyVars()))
    expect(m1.vars!.log).toHaveLength(1)
    expect(m1.vars!.turnSeq).toBe(3)
    expect(m1.vars!.scale).toBe(VAR_SCALE)
  })

  it('🔴 迁移幂等：第二次原样返回**同一个对象**（不是等值的新对象）', () => {
    const m1 = migrateVarScale(mkSession(legacyVars()))
    expect(migrateVarScale(m1)).toBe(m1)
  })

  it('🔴 迁移后再手改的数值，不会被下次打开抹掉', () => {
    const m1 = migrateVarScale(mkSession(legacyVars()))
    const edited: FreeSession = { ...m1, vars: { ...m1.vars!, values: { ...m1.vars!.values, affection: 20 } } }
    const m2 = migrateVarScale(edited)
    expect(m2).toBe(edited)
    expect(m2.vars!.values.affection).toBe(20)
  })

  it('本来就在新刻度上 → 原样返回同一个对象', () => {
    const fresh = mkSession(emptyVars())
    expect(migrateVarScale(fresh)).toBe(fresh)
  })

  it('压根没有数值块 → 不硬造一个出来', () => {
    const none = mkSession()
    expect(migrateVarScale(none)).toBe(none)
    expect(migrateVarScale(none).vars).toBeUndefined()
  })

  it('scale: 1 也走迁移；turnSeq / log 缺失时补 0 与 []', () => {
    const s: FreeSession = { ...mkSession(), vars: { values: { affection: 62 }, scale: 1 } as FreeSession['vars'] }
    const m = migrateVarScale(s)
    expect(m.vars!.values.affection).toBe(0)
    expect(m.vars!.turnSeq).toBe(0)
    expect(m.vars!.log).toEqual([])
  })

  it('迁移不改动会话的其它字段（消息 / 模型 / 标题逐字保留）', () => {
    const s = mkSession(legacyVars())
    const m = migrateVarScale(s)
    expect(m.id).toBe(s.id)
    expect(m.title).toBe(s.title)
    expect(m.messages).toBe(s.messages)
    expect(m.model).toBe(s.model)
  })
})

describe('setCharNote · 角色卡上的持久备注', () => {
  it('写入 / 覆盖备注，值取初始值（不是会话里的当前值）', () => {
    const cv = setCharNote(undefined, 'affection', '从陌生到熟悉的朋友')
    expect(cv.notes.affection).toBe('从陌生到熟悉的朋友')
    expect(cv.values).toEqual(emptyVars().values)
    expect(setCharNote(cv, 'affection', '已经当自己人了').notes.affection).toBe('已经当自己人了')
  })

  it('空串 / 纯空白 = 清掉这条备注', () => {
    const cv = setCharNote(undefined, 'affection', '旧备注')
    expect(setCharNote(cv, 'affection', '').notes.affection).toBeUndefined()
    expect(setCharNote(cv, 'affection', '   ').notes.affection).toBeUndefined()
    expect(Object.keys(setCharNote(cv, 'affection', ' ').notes)).toEqual([])
  })

  it('不原地改传进来的 cv（notes 与 values 都是新对象）', () => {
    const cv = setCharNote(undefined, 'affection', '甲')
    const next = setCharNote(cv, 'trust', '乙')
    expect(cv.notes.trust).toBeUndefined()
    expect(next).not.toBe(cv)
  })

  it('备注值两端空白被 trim', () => {
    expect(setCharNote(undefined, 'place', '  便利店收银台  ').notes.place).toBe('便利店收银台')
  })

  it('未传 cv 时也能用（values 按各变量初始值起步）', () => {
    expect(Object.keys(setCharNote(undefined, 'mood', '松了一点').values)).toEqual(VAR_DEFS.map(d => d.key))
  })
})
