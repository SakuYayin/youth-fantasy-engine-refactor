/**
 * `editor-status-bar-model.ts` 的纯逻辑测试（W9-1 / A-13）。
 *
 * 断言对象全部是「值 → 文案 / 补丁」的换算，不 mount 组件、不碰 DOM。
 * 期望值逐字来自上游 `NovelEditor.tsx:616-664` 与 `textStats.ts` / `useNovelEditorModel.ts`。
 */

import { describe, expect, it } from 'vitest'

import {
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_STATUS_BAR_COPY,
  EDITOR_STATUS_BAR_HELP_LINES,
  buildFontSizePatch,
  buildPageWidePatch,
  buildTypewriterPatch,
  chapterWordCount,
  chapterWordsText,
  chapterWordsTitle,
  clampEditorFontSize,
  editorFontStep,
  fontSizeValueText,
  fontSizeValueTitle,
  formatCount,
  pageWideButtonLabel,
  pageWideButtonTitle,
  parseEditorFontSize,
  stepEditorFontSize,
  todayWordsText,
  todayWordsTitle,
} from '../../src/renderer/features/editor-status-bar-model.js'

/* ---------------------------------- 字数口径（委托 @yfe/domain，B-13） ---------------------------------- */

describe('chapterWordCount / chapterWordsText —— 双口径本章字数', () => {
  it('空正文是 0 字（两种口径一致）', () => {
    expect(chapterWordCount('', false)).toBe(0)
    expect(chapterWordCount('', true)).toBe(0)
    expect(chapterWordsText('', false)).toBe('0 字')
  })

  it('「只算汉字」不数中文标点，「汉字＋标点」才把标点加进去', () => {
    expect(chapterWordCount('一二三。', false)).toBe(3)
    expect(chapterWordCount('一二三。', true)).toBe(4)
    expect(chapterWordsText('一二三。', false)).toBe('3 字')
    expect(chapterWordsText('一二三。', true)).toBe('4 字')
  })

  it('拉丁文按词算，且两种口径相同（标点口径只多算中文标点）', () => {
    expect(chapterWordCount('hello world', false)).toBe(2)
    expect(chapterWordCount('hello world', true)).toBe(2)
    expect(chapterWordCount('中文hello', false)).toBe(3)
  })

  it('显式口径与 wordCountModeOf 的映射一致（false ⇒ cjk）', () => {
    const text = '他说：“回去吧……”—— 一共 5 个字。'
    expect(chapterWordCount(text, false)).toBeLessThan(chapterWordCount(text, true))
  })

  it('超过 4 位数的本章字数按千分位显示', () => {
    expect(chapterWordsText('字'.repeat(12345), false)).toBe('12,345 字')
  })

  it('非字符串正文收敛成 0 字（渲染路径不抛 TypeError）', () => {
    expect(chapterWordCount(undefined as unknown as string, false)).toBe(0)
    expect(chapterWordCount(undefined as unknown as string, true)).toBe(0)
    expect(chapterWordsText(null as unknown as string, false)).toBe('0 字')
  })

  it('title 说清当前按哪一档算（上游 620 行文案）', () => {
    expect(chapterWordsTitle(false)).toBe('本章字数（只算汉字口径）')
    expect(chapterWordsTitle(true)).toBe('本章字数（汉字＋标点口径）')
  })
})

/* ------------------------------------------ 今日码字 ------------------------------------------ */

describe('todayWordsText / todayWordsTitle —— 今日码字（今日只经 props 传入）', () => {
  it('有数据时是「今日 N 字」，N 带千分位', () => {
    expect(todayWordsText(1234)).toBe('今日 1,234 字')
    expect(todayWordsText(1234567)).toBe('今日 1,234,567 字')
    expect(todayWordsText(999)).toBe('今日 999 字')
  })

  it('0 是「今天没写」，照常显示 0（不能和「读不到」混为一谈）', () => {
    expect(todayWordsText(0)).toBe('今日 0 字')
    expect(todayWordsTitle(0)).toBe(EDITOR_STATUS_BAR_COPY.todayTitle)
  })

  it('读不到数据（null / undefined / NaN / Infinity）显示 —，绝不显示 0', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const text = todayWordsText(value)
      expect(text).toBe('今日 — 字')
      expect(text).not.toContain('0')
    }
  })

  it('读不到数据时 title 说明原因（不是留空）', () => {
    expect(todayWordsTitle(null)).toBe(EDITOR_STATUS_BAR_COPY.todayUnavailableTitle)
    expect(todayWordsTitle(null)).toContain('暂不可用')
    expect(todayWordsTitle(undefined)).toBe(EDITOR_STATUS_BAR_COPY.todayUnavailableTitle)
  })

  it('净增量可以为负（删改多于新增），负数照实显示', () => {
    expect(todayWordsText(-5)).toBe('今日 -5 字')
    expect(todayWordsText(-1234)).toBe('今日 -1,234 字')
  })

  it('有数据时的 title 逐字对齐上游 623 行（含「按增删自动累计」与破折号）', () => {
    expect(todayWordsTitle(1200)).toBe(
      '今日码字量（按增删自动累计，固定「只算汉字」口径 —— 它记的是当天净增量，换口径也无法重算历史）',
    )
    expect(todayWordsTitle(1200)).toContain('固定「只算汉字」口径')
  })
})

/* ------------------------------------------ 千分位 ------------------------------------------ */

describe('formatCount —— 手写千分位分组', () => {
  it('三位以内不加分隔符', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(7)).toBe('7')
    expect(formatCount(999)).toBe('999')
  })

  it('四位以上按三位分组', () => {
    expect(formatCount(1000)).toBe('1,000')
    expect(formatCount(12345)).toBe('12,345')
    expect(formatCount(123456)).toBe('123,456')
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(1234567890)).toBe('1,234,567,890')
  })

  it('负数把符号放在分组外', () => {
    expect(formatCount(-5)).toBe('-5')
    expect(formatCount(-12345)).toBe('-12,345')
  })

  it('小数四舍五入到整数', () => {
    expect(formatCount(1234.4)).toBe('1,234')
    expect(formatCount(1234.6)).toBe('1,235')
  })

  it('非有限值收敛成 —（渲染路径不吐 NaN）', () => {
    expect(formatCount(Number.NaN)).toBe('—')
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe('—')
  })
})

/* ------------------------------------- 铺满 / 限宽 · 打字机 ------------------------------------- */

describe('pageWideButtonLabel / pageWideButtonTitle —— 铺满 / 限宽', () => {
  it('铺满态：可见词「铺满」，title 说明点击后变成限宽', () => {
    expect(pageWideButtonLabel(true)).toBe('铺满')
    expect(pageWideButtonTitle(true)).toBe('当前：码字区铺满窗口（点击改为限宽阅读）')
  })

  it('限宽态：可见词「限宽」，title 说明点击后变成铺满', () => {
    expect(pageWideButtonLabel(false)).toBe('限宽')
    expect(pageWideButtonTitle(false)).toBe('当前：限宽阅读（点击改为铺满窗口）')
  })
})

describe('打字机文案', () => {
  it('可见词与 title 逐字对齐上游 642 / 644 行', () => {
    expect(EDITOR_STATUS_BAR_COPY.typewriterLabel).toBe('打字机')
    expect(EDITOR_STATUS_BAR_COPY.typewriterTitle).toBe('打字机模式：输入行自动保持在屏幕中部')
  })
})

/* ------------------------------------------ 字号 ------------------------------------------ */

describe('parseEditorFontSize —— 脏设置不抛异常', () => {
  it('认得本仓的 \'16px\' 形态与上游的裸数字形态', () => {
    expect(parseEditorFontSize('16px')).toBe(16)
    expect(parseEditorFontSize('17')).toBe(17)
    expect(parseEditorFontSize(' 18px ')).toBe(18)
    expect(parseEditorFontSize('20PX')).toBe(EDITOR_FONT_SIZE_DEFAULT)
  })

  it('认不出来的一律回落上游默认 17', () => {
    for (const value of ['', 'abc', 'px', '0px', '-3px', null, undefined, '16.5em']) {
      expect(parseEditorFontSize(value as string | null | undefined)).toBe(17)
    }
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(17)
  })

  it('小数四舍五入，且不在这里钳制范围（显示字号必须等于实际字号）', () => {
    expect(parseEditorFontSize('16.5px')).toBe(17)
    expect(parseEditorFontSize('12px')).toBe(12)
    expect(parseEditorFontSize('32px')).toBe(32)
  })
})

describe('clampEditorFontSize / stepEditorFontSize —— 14–28 一步一档', () => {
  it('钳到 14–28（范围与上游 useNovelEditorModel 一致）', () => {
    expect(EDITOR_FONT_SIZE_MIN).toBe(14)
    expect(EDITOR_FONT_SIZE_MAX).toBe(28)
    expect(clampEditorFontSize(13)).toBe(14)
    expect(clampEditorFontSize(14)).toBe(14)
    expect(clampEditorFontSize(20)).toBe(20)
    expect(clampEditorFontSize(28)).toBe(28)
    expect(clampEditorFontSize(29)).toBe(28)
    expect(clampEditorFontSize(Number.NaN)).toBe(17)
  })

  it('±1 一步，越界不越出', () => {
    expect(stepEditorFontSize('16px', 1)).toBe(17)
    expect(stepEditorFontSize('16px', -1)).toBe(15)
    expect(stepEditorFontSize('14px', -1)).toBe(14)
    expect(stepEditorFontSize('28px', 1)).toBe(28)
    expect(stepEditorFontSize('12px', 1)).toBe(14)
    expect(stepEditorFontSize('32px', -1)).toBe(28)
  })

  it('入口是脏值 / 脏步长也不抛', () => {
    expect(stepEditorFontSize(null, 1)).toBe(18)
    expect(stepEditorFontSize(undefined, -1)).toBe(16)
    expect(stepEditorFontSize('16px', Number.NaN)).toBe(16)
  })

  it('一步结果给出两个方向还能不能动（按钮 :disabled 的依据）', () => {
    expect(editorFontStep('14px')).toEqual({ value: 14, canDecrease: false, canIncrease: true })
    expect(editorFontStep('28px')).toEqual({ value: 28, canDecrease: true, canIncrease: false })
    expect(editorFontStep('16px')).toEqual({ value: 16, canDecrease: true, canIncrease: true })
    expect(editorFontStep('32px')).toEqual({ value: 32, canDecrease: true, canIncrease: false })
    expect(editorFontStep(null)).toEqual({ value: 17, canDecrease: true, canIncrease: true })
  })

  it('读数与 title', () => {
    expect(fontSizeValueText(17)).toBe('17')
    expect(fontSizeValueTitle(17)).toBe('正文字号 17px')
  })
})

/* ----------------------------------------- 设置补丁 ----------------------------------------- */

describe('build*Patch —— 只吐补丁，不落盘', () => {
  it('铺满 / 打字机补丁的字段名与值', () => {
    expect(buildPageWidePatch(true)).toEqual({ pageWide: true })
    expect(buildPageWidePatch(false)).toEqual({ pageWide: false })
    expect(buildTypewriterPatch(true)).toEqual({ typewriter: true })
    expect(buildTypewriterPatch(false)).toEqual({ typewriter: false })
  })

  it('字号补丁用 \'17px\' 形态（与 settings-store 的 normalizeFontSize 同形）', () => {
    expect(buildFontSizePatch(17)).toEqual({ fontSize: '17px' })
    expect(buildFontSizePatch(20)).toEqual({ fontSize: '20px' })
  })

  it('字号补丁自带钳制（越界值进不去设置）', () => {
    expect(buildFontSizePatch(3)).toEqual({ fontSize: '14px' })
    expect(buildFontSizePatch(99)).toEqual({ fontSize: '28px' })
    expect(buildFontSizePatch(Number.NaN)).toEqual({ fontSize: '17px' })
  })

  it('补丁对象不含非设置字段（父层直接灌给 SettingsPort.save）', () => {
    expect(Object.keys(buildPageWidePatch(false))).toEqual(['pageWide'])
    expect(Object.keys(buildTypewriterPatch(true))).toEqual(['typewriter'])
    expect(Object.keys(buildFontSizePatch(17))).toEqual(['fontSize'])
  })
})

/* ---------------------------------------- 文案表自检 ---------------------------------------- */

describe('EDITOR_STATUS_BAR_COPY / HELP_LINES —— 文案表自检', () => {
  it('单位是「字」，两个标签逐字对齐上游', () => {
    expect(EDITOR_STATUS_BAR_COPY.unit).toBe('字')
    expect(EDITOR_STATUS_BAR_COPY.todayLabel).toBe('今日')
    expect(EDITOR_STATUS_BAR_COPY.unknownValue).toBe('—')
    expect(EDITOR_STATUS_BAR_COPY.pageWideLabel).toBe('铺满')
    expect(EDITOR_STATUS_BAR_COPY.narrowLabel).toBe('限宽')
    expect(EDITOR_STATUS_BAR_COPY.fontDecreaseLabel).toBe('减小字号')
    expect(EDITOR_STATUS_BAR_COPY.fontIncreaseLabel).toBe('增大字号')
    expect(EDITOR_STATUS_BAR_COPY.fontGroupLabel).toBe('正文字号')
  })

  it('说明气泡有 7 行，标题逐字对齐上游 661 行的 HelpPopover title', () => {
    expect(EDITOR_STATUS_BAR_HELP_LINES).toHaveLength(7)
    expect(EDITOR_STATUS_BAR_COPY.helpTitle).toBe('状态栏 · 码字体验设置')
    expect(EDITOR_STATUS_BAR_COPY.helpTriggerTitle).toBe('状态栏 · 码字体验设置（点击查看说明）')
    expect(EDITOR_STATUS_BAR_HELP_LINES[0]).toBe('左侧两项是实时状态：')
  })

  it('说明里不提「自动保存」（保存状态文案归 YfeStatusPill 独占）', () => {
    const help = EDITOR_STATUS_BAR_HELP_LINES.join('\n')
    expect(help).not.toContain('自动保存')
    expect(EDITOR_STATUS_BAR_COPY.helpTitle).not.toContain('保存')
  })

  it('说明里不指向本仓还没做的入口（写作面板字数口径开关 R-91、码字日历 C-02）', () => {
    const help = EDITOR_STATUS_BAR_HELP_LINES.join('\n')
    expect(help).not.toContain('写作面板')
    expect(help).not.toContain('码字日历')
  })

  it('说明保留「本机记忆，换章不重置」与字号范围', () => {
    const help = EDITOR_STATUS_BAR_HELP_LINES.join('\n')
    expect(help).toContain('本机记忆，换章不重置')
    expect(help).toContain('本机记忆')
    expect(help).toContain('正文字号 14–28px')
  })

  it('文案表是冻结的（防止别处就地改文案）', () => {
    expect(Object.isFrozen(EDITOR_STATUS_BAR_COPY)).toBe(true)
    expect(Object.isFrozen(EDITOR_STATUS_BAR_HELP_LINES)).toBe(true)
  })
})