/**
 * 素材资料面板纯逻辑测试（`material-data.ts`）：
 * - `filterMaterial` 过滤逻辑（分类 / 关键词 / 组合 / 不改入参）；
 * - 数据常量不变式（五大分类结构、条目字段完整性、分类覆盖）。
 * 组件挂载与交互见 material-library.view.test.ts。
 */
import { describe, expect, it } from 'vitest'

import {
  filterMaterial,
  MATERIAL_CATEGORIES,
  MATERIAL_ITEMS,
} from '../../src/renderer/panels/material-data.js'
import type { MaterialCategoryId, MaterialItem } from '../../src/renderer/panels/material-data.js'

/** 本地夹具条目：覆盖标题 / 摘要 / 正文三类命中点与英文大小写差异。 */
function fixture(
  id: string,
  category: MaterialCategoryId,
  title: string,
  summary: string,
  content: string,
): MaterialItem {
  return { id, category, title, summary, content }
}

const FIXTURES: readonly MaterialItem[] = [
  fixture(
    'fx-1',
    'character',
    '优雅贵气型',
    '端庄·分寸感',
    '核心气质：贵在不慌。\n造型符号：低饱和色、首饰少而精',
  ),
  fixture(
    'fx-2',
    'story-structure',
    '三幕结构',
    '建置 / 对抗 / 解决',
    '第一幕的枪第三幕要响',
  ),
  fixture(
    'fx-3',
    'writing',
    '五感词库',
    '视觉 / 听觉 / 嗅觉',
    'SilverSword 泛着冷光',
  ),
]

describe('filterMaterial 纯函数', () => {
  it('category=all 且关键词为空 → 返回全部条目', () => {
    const result = filterMaterial(FIXTURES, { category: 'all', keyword: '' })
    expect(result).toHaveLength(FIXTURES.length)
    expect(result.map((item) => item.id)).toEqual(['fx-1', 'fx-2', 'fx-3'])
  })

  it('category 筛选：只留该分类的条目', () => {
    const result = filterMaterial(FIXTURES, { category: 'character', keyword: '' })
    expect(result.map((item) => item.id)).toEqual(['fx-1'])
  })

  it('关键词命中标题 / 摘要 / 正文任一字段', () => {
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: '三幕' }).map((item) => item.id),
    ).toEqual(['fx-2'])
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: '分寸感' }).map((item) => item.id),
    ).toEqual(['fx-1'])
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: '冷光' }).map((item) => item.id),
    ).toEqual(['fx-3'])
  })

  it('关键词大小写不敏感（英文命中）', () => {
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: 'silversword' }).map((item) => item.id),
    ).toEqual(['fx-3'])
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: 'SILVERSWORD' }).map((item) => item.id),
    ).toEqual(['fx-3'])
  })

  it('关键词去首尾空白', () => {
    expect(
      filterMaterial(FIXTURES, { category: 'all', keyword: '  三幕  ' }).map((item) => item.id),
    ).toEqual(['fx-2'])
  })

  it('分类 + 关键词组合：两个条件同时生效', () => {
    expect(
      filterMaterial(FIXTURES, { category: 'writing', keyword: '五感' }).map((item) => item.id),
    ).toEqual(['fx-3'])
    expect(
      filterMaterial(FIXTURES, { category: 'character', keyword: '五感' }).map((item) => item.id),
    ).toEqual([])
  })

  it('无匹配 → 空数组（视图显「没有匹配的素材」说明）', () => {
    expect(filterMaterial(FIXTURES, { category: 'all', keyword: '不存在的词' })).toEqual([])
  })

  it('不修改入参数组，返回新数组', () => {
    const before = FIXTURES.map((item) => item.id)
    const result = filterMaterial(FIXTURES, { category: 'character', keyword: '' })
    expect(result).not.toBe(FIXTURES)
    expect(FIXTURES.map((item) => item.id)).toEqual(before)
  })

  it('对真实数据 MATERIAL_ITEMS：all+空关键词 → 全量', () => {
    expect(filterMaterial(MATERIAL_ITEMS, { category: 'all', keyword: '' })).toHaveLength(
      MATERIAL_ITEMS.length,
    )
  })

  it('对真实数据：category=character 只留人物设计条目', () => {
    const characters = filterMaterial(MATERIAL_ITEMS, { category: 'character', keyword: '' })
    expect(characters.length).toBeGreaterThan(0)
    expect(characters.every((item) => item.category === 'character')).toBe(true)
  })

  it('对真实数据：关键词「优雅贵气」命中且只含该关键词的条目', () => {
    const hits = filterMaterial(MATERIAL_ITEMS, { category: 'all', keyword: '优雅贵气' })
    expect(hits.length).toBeGreaterThan(0)
    expect(
      hits.every(
        (item) =>
          item.title.includes('优雅贵气') ||
          item.summary.includes('优雅贵气') ||
          item.content.includes('优雅贵气'),
      ),
    ).toBe(true)
  })
})

describe('素材数据常量不变式', () => {
  it('五大分类：id 与名称固定、顺序稳定、id 唯一', () => {
    expect(MATERIAL_CATEGORIES.map((category) => category.id)).toEqual([
      'character',
      'story-structure',
      'world-framework',
      'emotion',
      'writing',
    ])
    expect(MATERIAL_CATEGORIES.map((category) => category.name)).toEqual([
      '人物设计',
      '故事结构',
      '世界框架',
      '情绪爽点',
      '描写笔法',
    ])
    expect(new Set(MATERIAL_CATEGORIES.map((category) => category.id)).size).toBe(
      MATERIAL_CATEGORIES.length,
    )
  })

  it('条目：非空、id 唯一、category 合法、标题 / 摘要 / 正文齐全', () => {
    expect(MATERIAL_ITEMS.length).toBeGreaterThan(0)
    const validCategories = new Set<string>(MATERIAL_CATEGORIES.map((category) => category.id))
    expect(new Set(MATERIAL_ITEMS.map((item) => item.id)).size).toBe(MATERIAL_ITEMS.length)
    for (const item of MATERIAL_ITEMS) {
      expect(validCategories.has(item.category), `条目 ${item.id} 的分类非法：${item.category}`).toBe(
        true,
      )
      expect(item.title.length, `条目 ${item.id} 缺标题`).toBeGreaterThan(0)
      expect(item.summary.length, `条目 ${item.id} 缺摘要`).toBeGreaterThan(0)
      expect(item.content.length, `条目 ${item.id} 缺正文`).toBeGreaterThan(0)
    }
  })

  it('五大分类每类都有条目（代表性内容覆盖）', () => {
    for (const category of MATERIAL_CATEGORIES) {
      const count = MATERIAL_ITEMS.filter((item) => item.category === category.id).length
      expect(count, `分类 ${category.name} 没有条目`).toBeGreaterThan(0)
    }
  })
})
