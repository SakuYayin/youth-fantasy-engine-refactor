import { describe, expect, it } from 'vitest'

import {
  hasPrimaryModifier,
  HOTKEY_ENTRIES,
  HOTKEY_SAVE,
  HOTKEY_SEARCH,
  hotkeySummaryText,
  isSaveHotkeyEnabled,
  resolveHotkey,
  type SaveHotkeyStatus,
} from '../../src/renderer/features/hotkeys.js'

/** 只给 key，其余修饰键按需传入的紧凑构造器。 */
function press(key: string | undefined, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
  }
}

const ENABLED = { saveEnabled: true }
const DISABLED = { saveEnabled: false }

describe('hotkeys：六态保存状态折算（本仓口径）', () => {
  it('dirty 与 error 允许 Ctrl+S', () => {
    expect(isSaveHotkeyEnabled('dirty')).toBe(true)
    expect(isSaveHotkeyEnabled('error')).toBe(true)
  })

  it('saved / saving / conflict / offline 都不允许', () => {
    expect(isSaveHotkeyEnabled('saved')).toBe(false)
    expect(isSaveHotkeyEnabled('saving')).toBe(false)
    expect(isSaveHotkeyEnabled('conflict')).toBe(false)
    expect(isSaveHotkeyEnabled('offline')).toBe(false)
  })

  it('六态里恰好两态为真（新增状态时这条会红，提醒补折算规则）', () => {
    const all: readonly SaveHotkeyStatus[] = ['saved', 'dirty', 'saving', 'error', 'conflict', 'offline']
    expect(all.filter(isSaveHotkeyEnabled)).toEqual(['dirty', 'error'])
  })
})

describe('hotkeys：Ctrl/Cmd+S', () => {
  it('Ctrl+S 且有未保存改动 → draft.flush', () => {
    expect(resolveHotkey(press('s', { ctrl: true }), ENABLED)).toBe('draft.flush')
  })

  it('Cmd+S（metaKey）同样生效', () => {
    expect(resolveHotkey(press('s', { meta: true }), ENABLED)).toBe('draft.flush')
  })

  it('Shift 不影响（Ctrl+Shift+S 也算保存意图，key 仍为 s）', () => {
    expect(resolveHotkey(press('S', { ctrl: true }), ENABLED)).toBe('draft.flush')
  })

  it('带 Alt 的组合留给系统 → 不管', () => {
    expect(resolveHotkey(press('s', { ctrl: true, alt: true }), ENABLED)).toBeNull()
  })

  it('没有未保存改动 → 不管（不吞掉浏览器的「保存网页」）', () => {
    expect(resolveHotkey(press('s', { ctrl: true }), DISABLED)).toBeNull()
  })

  it('裸按 s / 只按 Ctrl → 不管', () => {
    expect(resolveHotkey(press('s'), ENABLED)).toBeNull()
    expect(resolveHotkey(press('s', { ctrl: false }), ENABLED)).toBeNull()
  })

  it('Ctrl 配其它键 → 不管', () => {
    expect(resolveHotkey(press('p', { ctrl: true }), ENABLED)).toBeNull()
    expect(resolveHotkey(press('enter', { ctrl: true }), ENABLED)).toBeNull()
  })

  it('key 缺失（个别键盘布局）→ 不管，不抛异常', () => {
    expect(resolveHotkey(press(undefined, { ctrl: true }), ENABLED)).toBeNull()
    expect(resolveHotkey({ ctrlKey: true }, ENABLED)).toBeNull()
  })
})

describe('hotkeys：Ctrl/Cmd+K（上游不排除 alt、与改动无关）', () => {
  it('Ctrl+K → search.open', () => {
    expect(resolveHotkey(press('k', { ctrl: true }), ENABLED)).toBe('search.open')
  })

  it('Cmd+K → search.open', () => {
    expect(resolveHotkey(press('k', { meta: true }), ENABLED)).toBe('search.open')
  })

  it('Ctrl+Alt+K 也生效（与 Ctrl+S 的处理不同，逐字对齐上游）', () => {
    expect(resolveHotkey(press('k', { ctrl: true, alt: true }), ENABLED)).toBe('search.open')
  })

  it('没有未保存改动时仍然生效', () => {
    expect(resolveHotkey(press('k', { ctrl: true }), DISABLED)).toBe('search.open')
  })

  it('大写 K 生效，裸 k 不生效', () => {
    expect(resolveHotkey(press('K', { ctrl: true }), ENABLED)).toBe('search.open')
    expect(resolveHotkey(press('k'), ENABLED)).toBeNull()
  })
})

describe('hotkeys：判定是纯函数 + 展示表', () => {
  it('同入参两次结果一致（无内部状态）', () => {
    const event = press('s', { ctrl: true })
    expect(resolveHotkey(event, ENABLED)).toBe(resolveHotkey(event, ENABLED))
  })

  it('hasPrimaryModifier：ctrl/meta 任一为真，alt 单独不算', () => {
    expect(hasPrimaryModifier(press('s', { ctrl: true }))).toBe(true)
    expect(hasPrimaryModifier(press('s', { meta: true }))).toBe(true)
    expect(hasPrimaryModifier(press('s', { alt: true }))).toBe(false)
    expect(hasPrimaryModifier({})).toBe(false)
  })

  it('展示表覆盖全部动作、文案非空且与常量一致', () => {
    expect(HOTKEY_ENTRIES.map((entry) => entry.action)).toEqual(['draft.flush', 'search.open'])
    expect(HOTKEY_ENTRIES[0]?.keys).toBe(HOTKEY_SAVE)
    expect(HOTKEY_ENTRIES[1]?.keys).toBe(HOTKEY_SEARCH)
    for (const entry of HOTKEY_ENTRIES) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.note.length).toBeGreaterThan(0)
    }
  })

  it('单行汇总文案含两条快捷键', () => {
    const text = hotkeySummaryText()
    expect(text).toContain(HOTKEY_SAVE)
    expect(text).toContain(HOTKEY_SEARCH)
    expect(text).toContain('保存当前草稿')
    expect(text).toContain('全文检索')
  })
})