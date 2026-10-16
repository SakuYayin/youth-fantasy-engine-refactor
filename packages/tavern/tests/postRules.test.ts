/**
 * postRules 单测 —— 上游 `tests/tavernPostRules.test.ts` 的 vitest 重写版。
 *
 * 上游那套用自写断言脚本逐条钉住了出厂规则的正则、替换串与**执行顺序**。
 * 顺序是这里唯一「改了也不报错、但结果会烂」的东西：星号规则必须排在
 * 「去 markdown」之后，否则 `**动作**` 会被拆成孤立星号 —— 所以专门有一条反例测试。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_POST_RULES,
  LEGACY_POST_RULES_VERSIONS,
  LEGACY_DEFAULT_POST_RULES,
  normalizePostRules,
  applyPostRules,
  previewPostRules,
} from '../src/postRules.js'
import type { PostRule } from '../src/postRules.js'

/** 跑一遍默认规则，只取文本 */
const run = (text: string) => applyPostRules(text, DEFAULT_POST_RULES)

/** 只留一条规则（按 id），便于把某个行为单独钉住 */
function only(id: string, enabled = true): PostRule[] {
  const r = DEFAULT_POST_RULES.find(x => x.id === id)
  if (!r) throw new Error(`没有这条出厂规则: ${id}`)
  return [{ ...r, enabled }]
}

const ruleOf = (id: string): PostRule => {
  const r = DEFAULT_POST_RULES.find(x => x.id === id)
  if (!r) throw new Error(`没有这条出厂规则: ${id}`)
  return r
}

describe('postRules · 出厂规则表本身', () => {
  it('6 条规则，其中 5 条默认开（只有行首说话人标签默认关）', () => {
    expect(DEFAULT_POST_RULES.length).toBe(6)
    expect(DEFAULT_POST_RULES.filter(r => r.enabled).length).toBe(5)
    expect(DEFAULT_POST_RULES.filter(r => !r.enabled).map(r => r.id)).toEqual(['pr-speaker-label'])
  })

  it('id 与顺序逐字固定（顺序即执行顺序）', () => {
    expect(DEFAULT_POST_RULES.map(r => r.id)).toEqual([
      'pr-halfwidth-paren', 'pr-strip-markdown', 'pr-star-action',
      'pr-no-blank-lines', 'pr-break-after-paren', 'pr-speaker-label',
    ])
  })

  it('每条都有名字、正则与说明，id 不重复', () => {
    for (const r of DEFAULT_POST_RULES) {
      expect(r.name.trim(), r.id).not.toBe('')
      expect(r.pattern.trim(), r.id).not.toBe('')
      expect(r.note ?? '', r.id).not.toBe('')
      expect(r.flags ?? 'gm', r.id).toBe('gm')
      expect(typeof r.replacement, r.id).toBe('string')
    }
    expect(new Set(DEFAULT_POST_RULES.map(r => r.id)).size).toBe(6)
  })

  it('「去 markdown」必须排在「星号动作」之前', () => {
    const ids = DEFAULT_POST_RULES.map(r => r.id)
    expect(ids.indexOf('pr-strip-markdown')).toBeLessThan(ids.indexOf('pr-star-action'))
    expect(DEFAULT_POST_RULES.find(r => r.id === 'pr-speaker-label')!.note).toContain('默认关')
  })

  it('正则源码与替换串逐字一致（改了这条，老用户的升级锚点就废了）', () => {
    expect(ruleOf('pr-halfwidth-paren')).toMatchObject({ pattern: '\\(([^)\\n]*)\\)', replacement: '（$1）' })
    expect(ruleOf('pr-strip-markdown')).toMatchObject({
      pattern: '\\*\\*(.+?)\\*\\*|`([^`\\n]+)`|^#{1,6}\\s*', replacement: '$1$2',
    })
    expect(ruleOf('pr-star-action')).toMatchObject({
      pattern: '\\*(?:（([^*\\n]*?)）|([^*\\n]+?))\\*', replacement: '（$1$2）',
    })
    expect(ruleOf('pr-no-blank-lines')).toMatchObject({ pattern: '\\n{2,}', replacement: '\n' })
    expect(ruleOf('pr-break-after-paren')).toMatchObject({ pattern: '）([^（\\n])', replacement: '）\n$1' })
    expect(ruleOf('pr-speaker-label')).toMatchObject({
      pattern: '^([\\u4e00-\\u9fa5A-Za-z]{2,6})[：:]\\s*', replacement: '', enabled: false,
    })
  })

  it('历史版本表两版，且 LEGACY_DEFAULT_POST_RULES 就是最早那一版', () => {
    expect(LEGACY_POST_RULES_VERSIONS.length).toBe(2)
    expect(LEGACY_DEFAULT_POST_RULES).toBe(LEGACY_POST_RULES_VERSIONS[0])
    expect(LEGACY_POST_RULES_VERSIONS.map(v => v.length)).toEqual([4, 4])
    expect(LEGACY_POST_RULES_VERSIONS[0]!.map(r => r.id)).toEqual([
      'pr-halfwidth-paren', 'pr-strip-markdown', 'pr-star-action', 'pr-speaker-label',
    ])
  })

  it('v1 与 v2 的差别只在 pr-star-action（v1 会把 *(动作)* 套成双层括号）', () => {
    const v1 = LEGACY_POST_RULES_VERSIONS[0]!.find(r => r.id === 'pr-star-action')!
    const v2 = LEGACY_POST_RULES_VERSIONS[1]!.find(r => r.id === 'pr-star-action')!
    expect(v1.pattern).toBe('\\*([^*\\n]+)\\*')
    expect(v2.pattern).toBe('\\*(?:（([^*\\n]*?)）|([^*\\n]+?))\\*')
    expect(applyPostRules('*（动作）*', [v1]).text).toBe('（（动作））')
    expect(applyPostRules('*（动作）*', [v2]).text).toBe('（动作）')
  })
})

describe('postRules · 逐条命中（默认开关下的实际效果）', () => {
  it('半角括号转全角', () => {
    expect(run('(她点了点头。)').text).toBe('（她点了点头。）')
    expect(run('（她点头。）').text).toBe('（她点头。）')
  })

  it('去掉加粗 / 行内代码 / 行首 #', () => {
    expect(run('**（他把烟按灭）**').text).toBe('（他把烟按灭）')
    expect(run('写了 `三` 个字。').text).toBe('写了 三 个字。')
    expect(run('## 第一场').text).toBe('第一场')
  })

  it('星号动作转成（动作）', () => {
    expect(run('*他把烟按灭*').text).toBe('（他把烟按灭）')
    // 星号里已经是括号时只脱星号，不许套成双层
    expect(applyPostRules('*（他把烟按灭）*', only('pr-star-action')).text).toBe('（他把烟按灭）')
  })

  it('默认关的说话人标签：开了才剥，关了「注意：」「他说：」一字不动', () => {
    expect(applyPostRules('洛汐：你来了。', only('pr-speaker-label')).text).toBe('你来了。')
    expect(applyPostRules('Alice: 你来了。', only('pr-speaker-label')).text).toBe('你来了。')
    expect(run('他说：你来了。').text).toBe('他说：你来了。')
    expect(run('注意：不要碰那台机器。').text).toBe('注意：不要碰那台机器。')
  })

  it('四个问题混在一起时一次修完，且顺序正确', () => {
    const input = ['（她点了点头。）', '**(他把烟按灭)**', '*把伞立在门口*', '洛汐：你来了。'].join('\n')
    const r = applyPostRules(input, DEFAULT_POST_RULES.map(x => ({ ...x, enabled: true })))
    expect(r.text).toBe(['（她点了点头。）', '（他把烟按灭）', '（把伞立在门口）', '你来了。'].join('\n'))
    expect(r.text).not.toContain('*')
    expect(r.applied.map(a => a.name)).toContain('去掉 markdown 装饰')
    expect(r.applied.map(a => a.name)).toContain('星号动作 → （动作）')
    expect(r.applied.map(a => a.name)).toContain('去掉行首说话人标签')
    // 这一组里没有空行、也没有「）后面直接跟字」，那两条不该被算成命中
    expect(r.applied.map(a => a.name)).not.toContain('去掉空行')
    expect(r.applied.map(a => a.name)).not.toContain('括号后换行')
    expect(r.errors).toEqual([])
  })

  it('顺序反了就会留下孤立星号（顺序反例，钉住「别随意调换」）', () => {
    const reversed = [
      ruleOf('pr-star-action'), ruleOf('pr-strip-markdown'),
      ruleOf('pr-halfwidth-paren'), ruleOf('pr-no-blank-lines'),
    ]
    expect(applyPostRules('**（他把烟按灭）**', reversed).text).toContain('*')
  })
})

describe('postRules · 不该误伤的东西', () => {
  it('已经合规的三行原样通过，applied 为空', () => {
    const clean = ['（她把找零推过来，没看我。）', '你来了。', '【雨声敲着便利店的玻璃，灯管闪了一下。】'].join('\n')
    const r = run(clean)
    expect(r.text).toBe(clean)
    expect(r.applied).toEqual([])
  })

  it('空串 / 隔代值不炸', () => {
    expect(run('').text).toBe('')
    expect(run('').applied).toEqual([])
    expect(applyPostRules('abc', []).text).toBe('abc')
  })

  it('规则全关时原文一字不动', () => {
    const text = '(她点头。)\n洛汐：你来了。'
    expect(applyPostRules(text, DEFAULT_POST_RULES.map(r => ({ ...r, enabled: false }))).text).toBe(text)
  })

  it('只开一条时其余规则不生效', () => {
    expect(applyPostRules('(她点头。)\n洛汐：你来了。', only('pr-halfwidth-paren')).text).toBe('（她点头。）\n洛汐：你来了。')
  })
})

describe('postRules · 出错与开关', () => {
  it('正则写坏只跳过那一条并记名，其余照跑', () => {
    const bad: PostRule[] = [
      { id: 'x', name: '写坏的正则', pattern: '([', replacement: '', enabled: true },
      { id: 'y', name: '正常规则', pattern: '啊', replacement: '呀', enabled: true },
    ]
    const r = applyPostRules('啊', bad)
    expect(r.errors).toEqual(['写坏的正则'])
    expect(r.text).toBe('呀')
    expect(r.applied.map(a => a.name)).toEqual(['正常规则'])
  })

  it('命中 0 次的规则不写进 applied（免得日志里全是没生效的项）', () => {
    expect(run('你来了。').applied).toEqual([])
  })

  it('命中次数被数出来，供界面显示', () => {
    const r = only('pr-halfwidth-paren')
    const out = applyPostRules('(a)(b)(c)', r)
    expect(out.applied).toEqual([{ name: '半角括号 → 全角', count: 3 }])
    expect(out.text).toBe('（a）（b）（c）')
  })

  it('previewPostRules 与 applyPostRules 结果一致（试一段不碰设置）', () => {
    expect(previewPostRules('(她点头。)', DEFAULT_POST_RULES).text).toBe('（她点头。）')
    expect(previewPostRules('', DEFAULT_POST_RULES)).toEqual({ text: '', applied: [], errors: [] })
  })
})

describe('postRules · 归一化脏数据', () => {
  it('不是数组就回落到出厂规则的全新副本', () => {
    for (const raw of [undefined, null, 'x', 42, {}]) {
      const n = normalizePostRules(raw)
      expect(n.length).toBe(6)
      expect(n).not.toBe(DEFAULT_POST_RULES)
      expect(n[0]).not.toBe(DEFAULT_POST_RULES[0])
      expect(n[0]!.id).toBe('pr-halfwidth-paren')
    }
  })

  it('缺字段的条目被补全：name / flags / enabled', () => {
    const n = normalizePostRules([{ pattern: 'a', replacement: 'b' }])
    expect(n).toEqual([{ id: 'pr-1', name: '未命名规则', pattern: 'a', replacement: 'b', flags: 'gm', enabled: true }])
    expect(applyPostRules('a', n).text).toBe('b')
  })

  it('只有明确写成 false 才算关（老数据缺字段时按开处理）', () => {
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', enabled: false }])[0]!.enabled).toBe(false)
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b' }])[0]!.enabled).toBe(true)
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', flags: '' }])[0]!.flags).toBe('gm')
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', flags: 'i' }])[0]!.flags).toBe('i')
  })

  it('没有正则的条目直接丢掉，非对象项也丢掉', () => {
    expect(normalizePostRules([{ name: '空的' }, { pattern: 'a', replacement: '' }]).length).toBe(1)
    expect(normalizePostRules([null, 7, 'x', { pattern: '  ' }]).length).toBe(0)
  })

  it('note 只在非空字符串时保留', () => {
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', note: '有话说' }])[0]!.note).toBe('有话说')
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', note: '' }])[0]).not.toHaveProperty('note')
    expect(normalizePostRules([{ pattern: 'a', replacement: 'b', note: 5 }])[0]).not.toHaveProperty('note')
  })
})

describe('postRules · 两条排版规则（上游单独钉过）', () => {
  it('去掉空行：连续换行压成一个，单个换行原样保留', () => {
    const r = only('pr-no-blank-lines')
    expect(applyPostRules('（他点头）\n\n你来了。', r).text).toBe('（他点头）\n你来了。')
    expect(applyPostRules('a\n\n\nb', r).text).toBe('a\nb')
    expect(applyPostRules('（他点头）\n你来了。', r).text).toBe('（他点头）\n你来了。')
    expect(applyPostRules('（他点头。）你来了。', r).text).toBe('（他点头。）你来了。')
  })

  it('括号后换行：描写接对白时插入换行，连续括号块不插断', () => {
    const r = only('pr-break-after-paren')
    expect(applyPostRules('（他冷笑）你以为你能逃？', r).text).toBe('（他冷笑）\n你以为你能逃？')
    expect(applyPostRules('（他冷笑）\n你以为你能逃？', r).text).toBe('（他冷笑）\n你以为你能逃？')
    expect(applyPostRules('（动作1）（动作2）对白', r).text).toBe('（动作1）（动作2）\n对白')
    expect(applyPostRules('你来了。（他转身离开）', r).text).toBe('你来了。（他转身离开）')
  })

  it('两条叠加时先压空行、再管换行', () => {
    const both = [ruleOf('pr-no-blank-lines'), ruleOf('pr-break-after-paren')]
    expect(applyPostRules('（他坐下）\n\n\n"坐吧。"', both).text).toBe('（他坐下）\n"坐吧。"')
    expect(applyPostRules('（他拍了拍肩）别怕。', both).text).toBe('（他拍了拍肩）\n别怕。')
  })
})
