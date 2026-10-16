/**
 * `params.ts` 契约测试 —— 采样参数的**继承式覆盖**与 **Ollama 字段改名**。
 *
 * 这一层有两个「抄错就会静默变味」的地方，所以断言锁的是行为而不是实现：
 *
 *  ① 覆盖链条：`会话参数 → 角色参数 → 模式默认 → 全局默认`，越靠后越优先。
 *     非法值（`NaN` / `Infinity`）**绝不能污染默认值** —— 否则本地模型会拿到
 *     `temperature: NaN` 这种直接让采样崩掉的脏值。
 *  ② 字段改名：内部 `repeatPenalty` → Ollama 的 `repeat_penalty`（**少了 "ition"**）。
 *     名字错了 Ollama 不报错，只是**静默忽略**这个参数 —— 那才是最难查的一类 bug。
 *
 * ⚠️ 本层**不做区间收敛**（不夹温度 / top_p 上下限）：它只丢弃非有限值。
 *    区间判定归 `settings.ts` / `paramGuide.ts`，这里刻意用一条断言把这个边界钉住，
 *    免得日后有人「顺手加个 clamp」把上限语义搬错地方。
 *
 * 上游对应断言：`_upstream_tmp/youth-fantasy-engine-main/tests/tavernPrompt.test.ts`
 * 第 269–295 行（「10) 参数继承」与「11) Ollama 字段映射」两节），已逐条翻译成 vitest。
 */

import { describe, expect, it } from 'vitest'

import { resolveParams, toOllamaOptions } from '../src/params.js'
import { TAVERN_DEFAULTS, type TavernParams } from '../src/types.js'

describe('resolveParams · 默认值填充', () => {
  it('不传任何层时，剧情模式填满 plot 的全部 9 个键（且一个不多一个不少）', () => {
    const p = resolveParams('plot')
    expect(Object.keys(p).sort()).toEqual(
      [
        'contextBudget',
        'frequencyPenalty',
        'numCtx',
        'presencePenalty',
        'repeatLastN',
        'repeatPenalty',
        'temperature',
        'topK',
        'topP',
      ].sort(),
    )
  })

  it('剧情默认温度 0.9，自由默认温度 0.95（自由更松）', () => {
    expect(resolveParams('plot').temperature).toBe(0.9)
    expect(resolveParams('free').temperature).toBe(0.95)
  })

  it('两种模式共享的取值完全一致：topP 0.92 / topK 60 / repeatPenalty 1.05 / repeatLastN 512', () => {
    for (const mode of ['plot', 'free'] as const) {
      const p = resolveParams(mode)
      expect(p.topP).toBe(0.92)
      expect(p.topK).toBe(60)
      expect(p.repeatPenalty).toBe(1.05)
      expect(p.repeatLastN).toBe(512)
      expect(p.numCtx).toBe(32768)
      expect(p.contextBudget).toBe(24000)
    }
  })

  it('🔴 刻意不同的一项：presencePenalty 剧情 0.5 / 自由 0.55（上游实验结论：不要统一）', () => {
    expect(resolveParams('plot').presencePenalty).toBe(0.5)
    expect(resolveParams('free').presencePenalty).toBe(0.55)
  })

  it('「治复读」的 frequencyPenalty 默认 0.1（Ollama 自带默认是 0＝关闭，必须显式打开）', () => {
    expect(resolveParams('plot').frequencyPenalty).toBe(0.1)
    expect(resolveParams('free').frequencyPenalty).toBe(0.1)
  })

  it('返回值是 TAVERN_DEFAULTS 的副本：改返回值不会污染共享常量', () => {
    const before = TAVERN_DEFAULTS.plot.temperature
    const p = resolveParams('plot')
    p.temperature = 2.5
    expect(TAVERN_DEFAULTS.plot.temperature).toBe(before)
    expect(resolveParams('plot').temperature).toBe(0.9)
  })
})

describe('resolveParams · 逐层覆盖与非法值收敛', () => {
  it('单层覆盖：高层压过模式默认', () => {
    expect(resolveParams('plot', { temperature: 1.2 }).temperature).toBe(1.2)
  })

  it('多层覆盖：后传入的层压过先传入的层，且未覆盖的键各自保留该层的值', () => {
    const layered = resolveParams('plot', { temperature: 1.0, topP: 0.5 }, { temperature: 1.2 })
    expect(layered.temperature).toBe(1.2)
    expect(layered.topP).toBe(0.5)
  })

  it('undefined 层被整层跳过，后面的层照常生效', () => {
    expect(resolveParams('plot', undefined, { topK: 7 }).topK).toBe(7)
  })

  it('NaN / Infinity 一律丢弃，不污染默认值', () => {
    const p = resolveParams('plot', { temperature: Number.NaN, topP: Number.POSITIVE_INFINITY })
    expect(p.temperature).toBe(0.9)
    expect(p.topP).toBe(0.92)
  })

  it('-Infinity 也被丢弃（只留有限值）', () => {
    expect(resolveParams('plot', { topK: Number.NEGATIVE_INFINITY }).topK).toBe(60)
  })

  it('显式 undefined 视同「这一层没写这一项」', () => {
    expect(resolveParams('plot', { temperature: undefined }).temperature).toBe(0.9)
  })

  it('空对象层不改变任何值', () => {
    expect(resolveParams('free', {})).toEqual(resolveParams('free'))
  })

  it('非 number 的脏值被丢弃：字符串 "1.5" 不会被采纳', () => {
    const dirty = { temperature: '1.5' } as unknown as TavernParams
    expect(resolveParams('plot', dirty).temperature).toBe(0.9)
  })

  it('非 number 的脏值被丢弃：null 不会被采纳（也不会抛错）', () => {
    const dirty = { topP: null } as unknown as TavernParams
    expect(resolveParams('plot', dirty).topP).toBe(0.92)
  })

  it('0 是合法值（不是「假值」）：温度 0 会被如实采纳', () => {
    expect(resolveParams('plot', { temperature: 0 }).temperature).toBe(0)
  })

  it('负数如实采纳 —— 本层不做区间收敛，上限/下限归 settings.ts 与 paramGuide.ts', () => {
    expect(resolveParams('plot', { topK: -3 }).topK).toBe(-3)
  })

  it('超限的大数如实采纳（同样不做 clamp）', () => {
    expect(resolveParams('plot', { temperature: 9 }).temperature).toBe(9)
  })

  it('零个覆盖层、一个覆盖层、多个覆盖层都返回同一形状', () => {
    const a = resolveParams('free')
    const b = resolveParams('free', { topK: 1 })
    const c = resolveParams('free', { topK: 1 }, { topK: 2 })
    expect(Object.keys(a).sort()).toEqual(Object.keys(c).sort())
    expect(b.topK).toBe(1)
    expect(c.topK).toBe(2)
  })
})

describe('toOllamaOptions · 输出键名与值的对应关系（逐字）', () => {
  it('剧情默认解析出来的 options 与预期对象逐字相等', () => {
    expect(toOllamaOptions(resolveParams('plot'))).toEqual({
      temperature: 0.9,
      top_p: 0.92,
      top_k: 60,
      repeat_penalty: 1.05,
      frequency_penalty: 0.1,
      repeat_last_n: 512,
      presence_penalty: 0.5,
      num_ctx: 32768,
    })
  })

  it('自由默认解析出来的 options 与预期对象逐字相等（presence_penalty 0.55）', () => {
    expect(toOllamaOptions(resolveParams('free'))).toEqual({
      temperature: 0.95,
      top_p: 0.92,
      top_k: 60,
      repeat_penalty: 1.05,
      frequency_penalty: 0.1,
      repeat_last_n: 512,
      presence_penalty: 0.55,
      num_ctx: 32768,
    })
  })

  it('「重复惩罚」映射为 repeat_penalty，且**没有** repetition_penalty', () => {
    const o = toOllamaOptions(resolveParams('plot'))
    expect('repeat_penalty' in o).toBe(true)
    expect('repetition_penalty' in o).toBe(false)
    expect(o.repeat_penalty).toBe(1.05)
  })

  it('键名是下划线而非驼峰：top_p / top_k / num_ctx / repeat_last_n 都对，驼峰名一个都不在', () => {
    const o = toOllamaOptions(resolveParams('plot'))
    expect('top_p' in o).toBe(true)
    expect('top_k' in o).toBe(true)
    expect('num_ctx' in o).toBe(true)
    expect('repeat_last_n' in o).toBe(true)
    expect('topP' in o).toBe(false)
    expect('topK' in o).toBe(false)
    expect('numCtx' in o).toBe(false)
    expect('repeatLastN' in o).toBe(false)
  })

  it('输出恰好 8 个键（contextBudget 不下发，它只是内部预算）', () => {
    const o = toOllamaOptions(resolveParams('plot'))
    expect(Object.keys(o)).toHaveLength(8)
    expect('contextBudget' in o).toBe(false)
  })

  it('每个值都确实来自解析结果：逐键改一个输入，只有对应的输出键跟着变', () => {
    const o = toOllamaOptions(resolveParams('plot', { topP: 0.123, topK: 7, repeatPenalty: 1.5 }))
    expect(o.top_p).toBe(0.123)
    expect(o.top_k).toBe(7)
    expect(o.repeat_penalty).toBe(1.5)
    // 没被覆盖的键必须保持默认，证明映射不是「全体写成同一个值」
    expect(o.temperature).toBe(0.9)
    expect(o.num_ctx).toBe(32768)
  })

  it('num_ctx 显式下发（不传时 Ollama 会按全局 128K 加载，显存爆掉）', () => {
    expect(toOllamaOptions(resolveParams('plot')).num_ctx).toBe(32768)
  })

  it('覆盖链路端到端：最后一层赢，且赢的值出现在 options 里', () => {
    const resolved = resolveParams('free', { temperature: 0.2 }, { temperature: 0.7 })
    expect(toOllamaOptions(resolved).temperature).toBe(0.7)
  })

  it('产出的是普通对象（可枚举、可 JSON 序列化，键序稳定）', () => {
    const o = toOllamaOptions(resolveParams('plot'))
    expect(Object.keys(o)).toEqual([
      'temperature',
      'top_p',
      'top_k',
      'repeat_penalty',
      'frequency_penalty',
      'repeat_last_n',
      'presence_penalty',
      'num_ctx',
    ])
    expect(JSON.parse(JSON.stringify(o))).toEqual(o)
  })
})
