#!/usr/bin/env node
/**
 * `@yfe/server` 的可执行入口（`npm run dev -w @yfe/server` / `npm start`）。
 *
 * 为什么是 `.mjs` 而不是 `.ts`：本包用 **Node 24 的类型剥离** 直接运行
 * `src` 下的 TypeScript 源码，不需要构建步骤（设计文档 04 的后端是模块化单体，
 * 不是要打 <code>src/**&#47;*.ts</code> 的产物）。类型剥离只解决"`.ts` 里有类型注解"，**不解决** 源码里按 ESM 规范
 * 写的 `./x.js` 说明符——那些文件在磁盘上叫 `x.ts`。所以这里用
 * `module.registerHooks` 把 `./x.js` 映射到 `./x.ts`（与桌面端 DB worker 同一套
 * 做法，见 `apps/desktop/src/main/db-worker.mjs`）。
 *
 * 🔴 这个映射只影响本进程的模块解析，不写盘、不改包内容。
 */

import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

if (typeof registerHooks !== 'function') {
  console.error(
    `启动失败：当前 Node 版本不支持 module.registerHooks（需要 Node 22.15+/24+），实际 ${process.version}。` +
      '本包依赖类型剥离直接运行 TypeScript，请升级 Node 或改用构建产物启动。',
  )
  process.exit(2)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { runServerCli } = await import('../src/cli.ts')

/** 等一次 SIGINT/SIGTERM，然后交给 `runServerCli` 做优雅停止。 */
function waitForShutdown() {
  return new Promise((resolvePromise) => {
    const onSignal = (signal) => {
      console.log(JSON.stringify({ event: 'server.signal', signal }))
      resolvePromise()
    }
    process.once('SIGINT', () => {
      onSignal('SIGINT')
    })
    process.once('SIGTERM', () => {
      onSignal('SIGTERM')
    })
  })
}

process.exitCode = await runServerCli(process.argv.slice(2), { waitForShutdown })
