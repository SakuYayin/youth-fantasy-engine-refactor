/**
 * 渲染层构建配置的**契约测试**。
 *
 * 这里不跑真构建（`vite build` 由门禁命令负责），只钉住两条"错了就白屏、而且很难查"的配置：
 *
 * 1. **产物 HTML 不得带 `crossorigin`。** Electron 生产走 `file://`（`main.mjs` 的
 *    `loadFile`），带 `crossorigin` 的标签按 CORS 模式取子资源，Chromium 对 `file://`
 *    的 CORS 请求一律拒绝 ⇒ 打包成功、测试全绿、一开窗白屏。
 * 2. **`base` 必须是相对路径 `'./'`。** 绝对路径（`/assets/...`）在 `file://` 下会解析到
 *    盘符根目录，同样是白屏。CSP 的 `script-src 'self'` 也依赖这一点。
 */

import { describe, expect, it } from 'vitest'
import type { Plugin, UserConfig } from 'vite'

import config from '../vite.config.js'

const resolved = config as UserConfig

function pluginByName(name: string): Plugin {
  const found = (resolved.plugins ?? [])
    .flat()
    .find((candidate): candidate is Plugin => (candidate as Plugin)?.name === name)
  if (found === undefined) throw new Error(`未找到插件：${name}`)
  return found
}

describe('渲染层构建配置', () => {
  it('产物 HTML 会被摘掉 crossorigin（file:// 下 CORS 会拒绝加载 ⇒ 白屏）', () => {
    const plugin = pluginByName('yfe-strip-crossorigin')
    const transform = plugin.transformIndexHtml
    expect(transform).toBeTypeOf('function')

    const input = [
      '<script type="module" crossorigin src="./assets/index.js"></script>',
      '<link rel="stylesheet" crossorigin href="./assets/index.css">',
    ].join('\n')

    // 只关心 html 一层：Vite 的 IndexHtmlTransformHook 还带 transformIndexHtmlContext，
    // 这里不需要它，收窄成单参函数调用（断言的是产物字符串，不是钩子签名）。
    const handler = (
      typeof transform === 'function' ? transform : transform?.handler
    ) as unknown as (html: string) => string
    const output = String(handler(input))
    expect(output).not.toContain('crossorigin')
    // 只摘属性，脚本与样式本身必须原样保留。
    expect(output).toContain('src="./assets/index.js"')
    expect(output).toContain('href="./assets/index.css"')
  })

  it('base 是相对路径，且产物落在 dist/renderer', () => {
    expect(resolved.base).toBe('./')
    expect(String(resolved.build?.outDir ?? '')).toContain('dist')
    expect(String(resolved.build?.outDir ?? '')).toContain('renderer')
  })
})
