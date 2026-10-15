/**
 * 渲染层构建配置（ADR 0006 / D1）。
 *
 * - `root` 指到 `src/renderer`，所以 `index.html` 与里面的 `./main.ts` 都在这一层；
 * - `base: './'`：产物用相对路径引用，配合 `index.html` 里写死的
 *   `script-src 'self'` 才能在 `file://` 下加载（Electron `loadFile`）；
 * - `outDir: dist/renderer`：`main.mjs` 生产路径按这个位置拼。
 *
 * ⚠️ 开发模式（`vite dev`）下 HMR 需要 WebSocket，而 `index.html` 的
 * `connect-src 'none'` 会把它挡掉——页面本身仍能加载，只是没有热更新。
 * 生产构建不受影响；要开 HMR 就临时改 CSP，别把放宽后的 CSP 提交进来。
 */

import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 摘掉产物 HTML 上的 `crossorigin`。
 *
 * Electron 生产用 `file://` 装载产物（`main.mjs` 的 `loadFile`）。带 `crossorigin`
 * 的 `<script>`/`<link>` 会走 CORS 模式，而 Chromium 对 `file://` 的 CORS 请求一律拒绝
 * （"Cross origin requests are only supported for protocol schemes: http, data, ..."），
 * 结果就是**白屏**——打包成功、测试全绿，一开窗什么都没有。Vite 默认给这两个标签加
 * `crossorigin`，所以必须在产物上摘掉，并由 renderer-build.test.ts 钉住这个行为。
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'yfe-strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html: string): string {
      return html.replaceAll(' crossorigin', '')
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [vue(), stripCrossorigin()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // Electron 自带 Chromium，不需要为老浏览器降级（白名单打包也更好预测）。
    target: 'chrome126',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 5200,
    strictPort: true,
  },
})
