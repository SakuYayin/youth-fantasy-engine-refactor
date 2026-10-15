/**
 * 「关于打赏」面板纯逻辑测试：只测 `about-content.ts` 的常量契约与纯函数。
 *
 * 不 mount 组件（视图行为在 about.view.test.ts），不摸 `navigator` / `state`，
 * 无需 DOM 环境（默认 node 环境）。
 */
import { describe, expect, it } from 'vitest'

import {
  APP_INTRO,
  APP_NAME,
  APP_NAME_EN,
  APP_SECTION_TITLE,
  CLIPBOARD_HINT,
  COPY_BUTTON_LABEL,
  COPY_FAILURE,
  COPY_SUCCESS,
  REBUILD_NOTES,
  REBUILD_TITLE,
  SUPPORT_DESC,
  SUPPORT_LINK,
  SUPPORT_LINK_NOTE,
  SUPPORT_TITLE,
  VERSION_FALLBACK,
  canUseClipboard,
  displayVersion,
} from '../../src/renderer/panels/about-content.js'
import { getTab } from '@yfe/schema-tabs'

// ==================== 常量契约 ====================

describe('about-content 常量', () => {
  it('支持链接是可分享的 http(s) 链接', () => {
    expect(SUPPORT_LINK).toMatch(/^https?:\/\//)
  })

  it('版本回退值非空（不静默空白）', () => {
    expect(VERSION_FALLBACK.length).toBeGreaterThan(0)
  })

  it('重构说明覆盖「本地 SQLite」「Vue 3」「预览版范围」三件事', () => {
    const all = REBUILD_NOTES.join('\n')
    expect(all).toContain('SQLite')
    expect(all).toContain('Vue 3')
    expect(all).toContain('预览版')
  })

  it('文案全部为中文语境（不含未翻译占位符）', () => {
    for (const text of [
      APP_SECTION_TITLE,
      APP_INTRO,
      REBUILD_TITLE,
      SUPPORT_TITLE,
      SUPPORT_DESC,
      SUPPORT_LINK_NOTE,
      COPY_BUTTON_LABEL,
      COPY_SUCCESS,
      COPY_FAILURE,
      CLIPBOARD_HINT,
    ]) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/TODO|FIXME|placeholder/i)
    }
    expect(APP_NAME).toContain('幻想')
    expect(APP_NAME_EN.length).toBeGreaterThan(0)
  })

  it('about 页签存在且 id 一致（页签文案 ⊆ 常量 ∪ 页签的审计锚点）', () => {
    const tab = getTab('about')
    if (tab === undefined) throw new Error('about 页签定义缺失')
    expect(tab.id).toBe('about')
    // 页签名（「关于打赏」）由 @yfe/schema-tabs 拥有，面板标题直接用 props.tab.name，不重复定义。
    expect(tab.name).toBe('关于打赏')
  })
})

// ==================== displayVersion ====================

describe('displayVersion', () => {
  it('有版本号时原样显示', () => {
    expect(displayVersion('0.1.0')).toBe('0.1.0')
    expect(displayVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4')
  })

  it('null 显「开发版」', () => {
    expect(displayVersion(null)).toBe(VERSION_FALLBACK)
  })

  it('空字符串 / 纯空白显「开发版」', () => {
    expect(displayVersion('')).toBe(VERSION_FALLBACK)
    expect(displayVersion('   ')).toBe(VERSION_FALLBACK)
    expect(displayVersion('\t\n')).toBe(VERSION_FALLBACK)
  })

  it('带首尾空白的版本号去空白后显示', () => {
    expect(displayVersion(' 0.2.0 ')).toBe('0.2.0')
  })
})

// ==================== canUseClipboard ====================

describe('canUseClipboard', () => {
  it('有 writeText 函数 → 可用', () => {
    expect(canUseClipboard({ writeText: async () => undefined })).toBe(true)
  })

  it('writeText 缺失或不是函数 → 不可用', () => {
    expect(canUseClipboard({})).toBe(false)
    expect(canUseClipboard({ writeText: 'not-a-function' })).toBe(false)
  })

  it('剪贴板对象为 null / 非对象 → 不可用', () => {
    expect(canUseClipboard(null)).toBe(false)
    expect(canUseClipboard(undefined)).toBe(false)
    expect(canUseClipboard('clipboard')).toBe(false)
  })
})
