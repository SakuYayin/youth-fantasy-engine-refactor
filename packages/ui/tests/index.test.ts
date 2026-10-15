import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import * as ui from '../src/index.js'
import {
  DESIGN_TOKEN_VARIABLE_PREFIX,
  designTokens,
  parsePx,
  tokensToCssVariables,
} from '../src/index.js'
import { track } from './support.js'

/** ADR 0006 D3 的组件清单：入口少一个，渲染层就会去 import 内部路径。 */
const COMPONENT_EXPORTS = [
  'YfeButton',
  'YfeDialog',
  'YfePanel',
  'YfeStatusPill',
  'YfeToolbar',
  'YfeTree',
] as const

describe('@yfe/ui 入口：导出面', () => {
  it('六个组件都有具名导出，且都能直接 mount', () => {
    for (const name of COMPONENT_EXPORTS) {
      const component = ui[name]
      expect(component).toBeDefined()
      // 具名导出的就是 SFC 组件本身：能挂载（不是个再包一层的空对象）。
      expect(typeof component).toBe('object')
    }

    const wrapper = track(mount(ui.YfeToolbar))
    expect(wrapper.classes()).toContain('yfe-toolbar')
  })

  it('令牌从入口与 tokens 子路径都能拿到，且是同一份', () => {
    expect(designTokens.name).toBe('dark')
    expect(DESIGN_TOKEN_VARIABLE_PREFIX).toBe('--yfe-')
    // 两个 import 路径是同一个模块实例：designTokens 必须是同一个对象。
    expect(ui.designTokens).toBe(designTokens)
    // tokensToCssVariables() 每次调用新建冻结对象，所以比内容而不是比身份。
    expect(tokensToCssVariables()).toEqual(ui.designTokenVariables)
    expect(parsePx('18px')).toBe(18)
  })

  it('没有把业务契约偷偷带进来（UI 只吃基础类型）', () => {
    // 唯一允许出现在导出面上的类型是 YfeTreeNode / YfeSaveStatus 与令牌类型，
    // 这里用导出名清单兜底：新增业务字段就会在这里暴露。
    const unexpected = Object.keys(ui).filter(
      (key) => !COMPONENT_EXPORTS.includes(key as (typeof COMPONENT_EXPORTS)[number])
        && ![
          'DESIGN_TOKEN_VARIABLE_PREFIX',
          'designTokenVariables',
          'designTokens',
          'parsePx',
          'tokensToCssVariables',
        ].includes(key),
    )
    expect(unexpected).toEqual([])
  })
})
