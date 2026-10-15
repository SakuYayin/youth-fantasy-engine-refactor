import { describe, expect, it } from 'vitest'

import {
  DESIGN_TOKEN_VARIABLE_PREFIX,
  designTokenVariables,
  designTokens,
  parsePx,
  tokensToCssVariables,
} from '../src/tokens.js'

/**
 * 显式列出全部变量名：令牌键名是**公共契约**（`05-插件内核与SDK.md` 要求主题
 * 按同一套语义令牌覆盖，桌面与手机共用），随手改名会让下游主题静默失效。
 * 这份清单故意写死，改令牌就必须改这里——让它变成一次有意识的决定。
 */
const EXPECTED_VARIABLE_KEYS = [
  // color
  '--yfe-color-accent',
  '--yfe-color-accent-hover',
  '--yfe-color-background',
  '--yfe-color-border',
  '--yfe-color-border-strong',
  '--yfe-color-danger',
  '--yfe-color-danger-hover',
  '--yfe-color-focus-ring',
  '--yfe-color-overlay',
  '--yfe-color-success',
  '--yfe-color-surface',
  '--yfe-color-surface-raised',
  '--yfe-color-text',
  '--yfe-color-text-muted',
  '--yfe-color-text-on-accent',
  '--yfe-color-warning',
  // space
  '--yfe-space-lg',
  '--yfe-space-md',
  '--yfe-space-none',
  '--yfe-space-sm',
  '--yfe-space-xl',
  '--yfe-space-xs',
  '--yfe-space-xxl',
  // radius
  '--yfe-radius-lg',
  '--yfe-radius-md',
  '--yfe-radius-none',
  '--yfe-radius-pill',
  '--yfe-radius-sm',
  // font
  '--yfe-font-family',
  '--yfe-font-family-mono',
  '--yfe-font-line-height',
  '--yfe-font-size-lg',
  '--yfe-font-size-md',
  '--yfe-font-size-sm',
  '--yfe-font-weight-bold',
  '--yfe-font-weight-medium',
  '--yfe-font-weight-regular',
  // layer
  '--yfe-layer-content',
  '--yfe-layer-dialog',
  '--yfe-layer-sticky',
  '--yfe-layer-toast',
  // size
  '--yfe-size-border-width',
  '--yfe-size-control-height',
  '--yfe-size-control-height-sm',
  '--yfe-size-focus-width',
  '--yfe-size-status-dot',
  '--yfe-size-tree-indent',
].sort()

describe('设计令牌：键集合与派生', () => {
  it('CSS 变量键集合固定（改名即破坏主题契约）', () => {
    expect(Object.keys(designTokenVariables).sort()).toEqual(EXPECTED_VARIABLE_KEYS)
    expect(Object.keys(designTokenVariables).every((key) => key.startsWith(DESIGN_TOKEN_VARIABLE_PREFIX))).toBe(
      true,
    )
  })

  it('深色为默认主题，且与桌面占位页配色一致', () => {
    expect(designTokens.name).toBe('dark')
    expect(DESIGN_TOKEN_VARIABLE_PREFIX).toBe('--yfe-')
    // 这四个值逐字取自 apps/desktop/src/renderer/index.html，改一处要一起改。
    expect(designTokenVariables['--yfe-color-background']).toBe('#111318')
    expect(designTokenVariables['--yfe-color-surface']).toBe('#1a1d25')
    expect(designTokenVariables['--yfe-color-border']).toBe('#2a2f3a')
    expect(designTokenVariables['--yfe-color-text']).toBe('#e6e8ee')
    expect(designTokenVariables['--yfe-color-success']).toBe('#5ddc9a')
    expect(designTokenVariables['--yfe-color-danger']).toBe('#ff7b72')
  })

  it('令牌与变量表都被冻结（防止运行期被就地改坏）', () => {
    expect(Object.isFrozen(designTokens)).toBe(true)
    expect(Object.isFrozen(designTokens.color)).toBe(true)
    expect(Object.isFrozen(designTokens.size)).toBe(true)
    expect(Object.isFrozen(designTokenVariables)).toBe(true)
  })

  it('同构主题产出同一套键名（外部主题只换值不换名）', () => {
    const lightTheme = {
      ...designTokens,
      name: 'light',
      color: { ...designTokens.color, background: '#ffffff' },
    }
    const variables = tokensToCssVariables(lightTheme)

    expect(Object.keys(variables).sort()).toEqual(EXPECTED_VARIABLE_KEYS)
    expect(variables['--yfe-color-background']).toBe('#ffffff')
    expect(variables['--yfe-color-text']).toBe(designTokenVariables['--yfe-color-text'])
  })

  it('parsePx 只接受 px 长度，其它单位直接抛错', () => {
    expect(parsePx('18px')).toBe(18)
    expect(parsePx('-2.5px')).toBe(-2.5)
    expect(parsePx(designTokens.size.treeIndent)).toBe(18)
    // rem/em 的换算依赖根字号，猜一个值会让「按 depth 缩进」变成静默错误。
    expect(() => parsePx('1rem')).toThrow(RangeError)
    expect(() => parsePx('')).toThrow(RangeError)
  })
})
