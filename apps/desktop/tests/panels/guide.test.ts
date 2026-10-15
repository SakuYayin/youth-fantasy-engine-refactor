/**
 * 「使用指南」面板纯逻辑单测：`guide-content.ts` 常量（无 DOM、无挂载）。
 *
 * 验收（`docs/接口冻结-面板层.md` §6）：
 * - 至少四节：快速上手 / 设定与资料 / 模型配置 / 常见问题；
 * - 文案口径：保存状态六态的中文标签与 `@yfe/ui` 的 `YfeStatusPill`（ADR 0006 D5
 *   的唯一来源）逐字一致；页签名、分组与 `@yfe/schema-tabs` 的侧栏页签一致；
 * - 不复制其它页签的描述文案（可见文本 ⊆ 页签文案 ∪ 本文件常量）。
 */
import { describe, expect, it } from 'vitest'

import { getTab, TABS } from '@yfe/schema-tabs'

import { GUIDE_INTRO, GUIDE_SECTIONS } from '../../src/renderer/panels/guide-content.js'

/** 指南全文（引言 + 各节标题与条目），供「不照抄」断言使用。 */
const GUIDE_TEXT: string = [
  GUIDE_INTRO.join('\n'),
  ...GUIDE_SECTIONS.map((section) => [section.title, ...section.items].join('\n')),
].join('\n')

/** 常见问题一节的条目合并文本；找不到必备节时为空串（由断言负责报红）。 */
function faqText(): string {
  const faq = GUIDE_SECTIONS.find((section) => section.id === 'faq')
  return faq !== undefined ? faq.items.join('\n') : ''
}

describe('指南结构', () => {
  it('至少四节，必备节（快速上手/设定与资料/模型配置/常见问题）都在', () => {
    expect(GUIDE_SECTIONS.length).toBeGreaterThanOrEqual(4)
    const ids = GUIDE_SECTIONS.map((section) => section.id)
    expect(ids).toEqual(
      expect.arrayContaining(['quick-start', 'data-tabs', 'model-config', 'faq']),
    )
  })

  it('每节 id 唯一且非空，标题与每条条目都非空', () => {
    const ids = GUIDE_SECTIONS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of GUIDE_SECTIONS) {
      expect(section.id.trim().length).toBeGreaterThan(0)
      expect(section.title.trim().length).toBeGreaterThan(0)
      expect(section.items.length).toBeGreaterThan(0)
      for (const item of section.items) {
        expect(item.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('页首引言非空，每一行都非空', () => {
    expect(GUIDE_INTRO.length).toBeGreaterThan(0)
    for (const line of GUIDE_INTRO) {
      expect(line.trim().length).toBeGreaterThan(0)
    }
  })

  it('guide 页签在侧栏 TABS 里，元数据一致（分组=工作面板，type=guide）', () => {
    const tab = getTab('guide')
    expect(tab, '侧栏 TABS 里没有 guide 页签（schema-tabs 缺口）').toBeDefined()
    if (tab !== undefined) {
      expect(tab.name).toBe('使用指南')
      expect(tab.group).toBe('工作面板')
      expect(tab.type).toBe('guide')
    }
  })
})

describe('文案口径', () => {
  it('常见问题一节覆盖保存状态六态，中文标签与 YfeStatusPill 的唯一来源逐字一致', () => {
    // 镜像 packages/ui/src/components/YfeStatusPill.vue 的 STATUS_LABELS
    // （ADR 0006 D5：六态中文文案只在那里映射一次，别处不得自造）。
    const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
      saved: '本地已保存',
      dirty: '有未保存修改',
      saving: '保存中',
      error: '保存失败',
      conflict: '冲突',
      offline: '离线（本地已保存）',
    })
    const text = faqText()
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      expect(text, `常见问题缺保存状态 ${status} 的条目`).toContain(status)
      expect(text, `保存状态 ${status} 的中文标签「${label}」缺失或写法不一致`).toContain(label)
    }
  })

  it('常见问题说明「保存状态与同步状态分开」与「离线也能写」', () => {
    const text = faqText()
    expect(text).toContain('保存状态与同步状态')
    expect(text).toContain('离线也能写')
  })

  it('模型配置一节说清三要素（接口地址/模型名/API Key）与「模型设置」页签', () => {
    const section = GUIDE_SECTIONS.find((entry) => entry.id === 'model-config')
    expect(section).toBeDefined()
    const text = section !== undefined ? section.items.join('\n') : ''
    expect(text).toContain('模型设置')
    expect(text).toContain('接口地址')
    expect(text).toContain('模型名')
    expect(text).toContain('API Key')
  })

  it('设定与资料一节覆盖表单/表格/卡片三类页签的用法', () => {
    const section = GUIDE_SECTIONS.find((entry) => entry.id === 'data-tabs')
    expect(section).toBeDefined()
    const text = section !== undefined ? section.items.join('\n') : ''
    expect(text).toContain('表单')
    expect(text).toContain('表格')
    expect(text).toContain('卡片')
  })

  it('不复制其它页签的描述文案（可见文本 ⊆ 页签文案 ∪ 本文件常量）', () => {
    for (const tab of TABS) {
      if (tab.id === 'guide') continue
      // 页签描述是长句：整句撞车只能是照抄；个别通用词重复不算。
      if (tab.description.length >= 8) {
        expect(GUIDE_TEXT, `不应照抄页签「${tab.name}」的描述文案`).not.toContain(tab.description)
      }
    }
  })
})
