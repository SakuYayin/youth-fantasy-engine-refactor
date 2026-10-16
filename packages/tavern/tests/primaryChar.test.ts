/**
 * `primaryChar.ts` 契约测试 —— 本场「主角色」= **AI 扮演的第一个角色**（排除用户扮演的那个）。
 *
 * 这 20 行管着一件很贵的事：本场状态（好感 / 信任 / 精神…）最终**回写到哪张角色卡**。
 * 反馈 #16 的根因就是主角色被死写成 `charIds[0]` —— 用户把「我演」放在位置 1 时，
 * 状态会算进并写回**用户卡**。所以这里把全部分支都钉住：
 *
 *  · 有 userCharId → 取「过滤掉用户之后」的第一个（不是 charIds[1]，也不是 charIds[0]）；
 *  · 位置随意 —— 用户卡放中间时，取到的是它**后面**那个 AI 角色；
 *  · 无 userCharId / 用户不在名单里 / 名单里只剩用户 → 回退 `charIds[0]`，保持旧行为；
 *  · 空名单 → 空串（调用方据此判「本场没有 AI 角色」），绝不返回 undefined。
 *
 * 上游没有独立测试文件，行为取自 `primaryChar.ts` 的文档注释与实现。
 */

import { describe, expect, it } from 'vitest'

import { primaryAiCharId } from '../src/primaryChar.js'

describe('primaryAiCharId · 有 userCharId 时排除用户卡', () => {
  it('用户卡在位置 1 → 取位置 2 的 AI 角色（反馈 #16 的原始场景）', () => {
    expect(primaryAiCharId({ charIds: ['u1', 'a2', 'a3'], userCharId: 'u1' })).toBe('a2')
  })

  it('用户卡在位置 2 → 取位置 1 的 AI 角色（过滤后第一个，不是 charIds[1]）', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'u1', 'a3'], userCharId: 'u1' })).toBe('a1')
  })

  it('用户卡在末尾 → 取它前面第一个 AI 角色', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2', 'u1'], userCharId: 'u1' })).toBe('a1')
  })

  it('多个 AI 角色时只取过滤后的第一个', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2', 'a3'], userCharId: 'u9' })).toBe('a1')
  })

  it('用户卡不在名单里时也照常排除逻辑走（无匹配可滤，等于取 charIds[0]）', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2'], userCharId: 'u-missing' })).toBe('a1')
  })

  it('userCharId 为 null（显式「这一场我不演」）→ 回退 charIds[0]', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2'], userCharId: null })).toBe('a1')
  })

  it('🔴 过滤后只剩用户自己 → AI 列表为空 → 回退 charIds[0]（即用户卡，保持旧行为不崩）', () => {
    expect(primaryAiCharId({ charIds: ['u1'], userCharId: 'u1' })).toBe('u1')
  })
})

describe('primaryAiCharId · 无 userCharId 时保持旧行为', () => {
  it('不传 userCharId（纯 AI 多角色）→ 取 charIds[0]', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2'] })).toBe('a1')
  })

  it('userCharId 为空串（假值）→ 不走过滤分支，取 charIds[0]', () => {
    expect(primaryAiCharId({ charIds: ['a1', 'a2'], userCharId: '' })).toBe('a1')
  })

  it('userCharId 为 undefined 与不传等价', () => {
    expect(primaryAiCharId({ charIds: ['a1'], userCharId: undefined })).toBe('a1')
  })
})

describe('primaryAiCharId · 空输入与边界', () => {
  it('空名单 + 无 userCharId → 空串（不是 undefined，调用方可直接判空）', () => {
    const r = primaryAiCharId({ charIds: [] })
    expect(r).toBe('')
    expect(typeof r).toBe('string')
  })

  it('空名单 + 有 userCharId → 空串（过滤后为空，回退 charIds[0] 也是 undefined → 空串）', () => {
    expect(primaryAiCharId({ charIds: [], userCharId: 'u1' })).toBe('')
  })

  it('名单里只有用户卡且无 userCharId → 原样返回该卡（本层不判断它是不是用户）', () => {
    expect(primaryAiCharId({ charIds: ['u1'] })).toBe('u1')
  })

  it('不修改传入的 charIds 数组（纯函数，无副作用）', () => {
    const charIds = ['u1', 'a2', 'a3']
    primaryAiCharId({ charIds, userCharId: 'u1' })
    expect(charIds).toEqual(['u1', 'a2', 'a3'])
  })

  it('纯函数：同输入重复调用结果稳定一致', () => {
    const s = { charIds: ['u1', 'a2', 'a3'], userCharId: 'u1' }
    expect(primaryAiCharId(s)).toBe(primaryAiCharId(s))
    expect(primaryAiCharId(s)).toBe('a2')
  })

  it('id 全等比较（不做 trim / 大小写归一）：带空格的 id 不匹配同名无空格 id', () => {
    expect(primaryAiCharId({ charIds: ['u1', 'a2'], userCharId: ' u1 ' })).toBe('u1')
  })

  it('全 AI 多角色名单不会误删任何东西：返回的必是名单里的成员', () => {
    const charIds = ['a1', 'a2', 'a3']
    expect(charIds).toContain(primaryAiCharId({ charIds, userCharId: 'u1' }))
  })
})
