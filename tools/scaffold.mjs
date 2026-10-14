#!/usr/bin/env node
/**
 * 工作区脚手架生成器。
 *
 * 为什么用脚本而不是手写每个文件：
 * 1. 6 个包的 package.json / tsconfig.json / vitest.config.ts 必须**完全同构**，
 *    手写必然出现细微漂移（少了 noUncheckedIndexedAccess、root 指错、project 名不一致）。
 * 2. 根配置与包配置是**共享文件**，按并发纪律只能由 Lead 独占生成。
 * 3. 幂等：重复执行不覆盖已存在的 src 源码，只重建配置文件。
 *
 * 用法：node tools/scaffold.mjs
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '4.0.0-dev.0'

/** 统一 tsconfig：extends 根配置，rootDir 指 src，排除测试文件。 */
const tsconfigFor = () => ({
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    rootDir: 'src',
    outDir: 'dist',
    tsBuildInfoFile: 'dist/.tsbuildinfo',
  },
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts', 'dist', 'node_modules'],
})

/** 统一 vitest project 配置：每个包一个 project，便于 --project 单独运行。 */
const vitestFor = (name) => `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '${name}',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
})
`

const existing = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const writeIfAbsent = async (rel, content, { overwrite = false } = {}) => {
  const path = join(ROOT, rel)
  if (!overwrite && (await existing(path))) return 'skip'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return 'write'
}

// ---------------------------------------------------------------------------
// 包清单：每个包的名称、说明、依赖、导出子路径
// ---------------------------------------------------------------------------

const packages = [
  {
    dir: 'packages/domain',
    name: '@yfe/domain',
    description: '领域内核：正文归一化、字数统计、排序键、合并规则。纯逻辑，不依赖 IO',
    deps: { '@yfe/contracts': '*' },
    exports: ['.', './text', './orderKey', './merge'],
  },
  {
    dir: 'packages/persistence-sqlite',
    name: '@yfe/persistence-sqlite',
    description: 'SQLite 持久化：Schema 迁移、SaveDraft 事务、Repository',
    deps: { '@yfe/contracts': '*', '@yfe/domain': '*', 'better-sqlite3': '^13.0.3' },
    devDeps: { '@types/better-sqlite3': '^7.6.12' },
    exports: ['.', './schema', './repositories'],
  },
  {
    dir: 'packages/application',
    name: '@yfe/application',
    description: '应用用例层：编排领域规则与持久化，不依赖具体 UI 或全局当前作品',
    deps: { '@yfe/contracts': '*', '@yfe/domain': '*', '@yfe/persistence-sqlite': '*' },
    exports: ['.', './projects', './documents', './snapshot', './export'],
  },
  {
    dir: 'packages/plugin-sdk',
    name: '@yfe/plugin-sdk',
    description: '插件 SDK：第三方插件唯一允许依赖的接口面，不暴露 Cordis 类型',
    deps: { '@yfe/contracts': '*' },
    exports: ['.', './manifest', './context'],
  },
  {
    dir: 'packages/plugin-host',
    name: '@yfe/plugin-host',
    description: '插件宿主：Cordis 适配层，隔离上游不稳定的生命周期 API',
    deps: { '@yfe/contracts': '*', '@yfe/plugin-sdk': '*', cordis: '4.0.0-rc.11' },
    exports: ['.', './host'],
  },
]

const services = [
  {
    dir: 'services/server',
    name: '@yfe/server',
    description: '后端服务：Fastify 5 + SQLite，模块化单体（身份/权限/同步/任务/附件）',
    deps: {
      '@yfe/contracts': '*',
      '@yfe/domain': '*',
      '@yfe/application': '*',
      '@yfe/persistence-sqlite': '*',
      fastify: '^5.12.7',
      '@fastify/cookie': '^11.1.3',
    },
    exports: ['.', './routes', './auth', './permission', './sync'],
    isService: true,
  },
]

const makePackageJson = (spec) => {
  const exportsMap = {}
  for (const key of spec.exports) {
    const target =
      key === '.'
        ? spec.isService
          ? './src/index.ts'
          : './src/index.ts'
        : `./src/${key.slice(2)}/index.ts`
    exportsMap[key] = { types: target, default: target }
  }

  return (
    JSON.stringify(
      {
        name: spec.name,
        version: VERSION,
        private: true,
        type: 'module',
        description: spec.description,
        exports: exportsMap,
        ...(spec.deps ? { dependencies: spec.deps } : {}),
        ...(spec.devDeps ? { devDependencies: spec.devDeps } : {}),
        scripts: {
          typecheck: 'tsc --noEmit -p tsconfig.json',
          test: 'vitest run',
        },
      },
      null,
      2,
    ) + '\n'
  )
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const report = []

for (const spec of [...packages, ...services]) {
  const projectName = spec.name.replace('@yfe/', '').replace('server', 'server')
  const changed = []

  if ((await writeIfAbsent(`${spec.dir}/package.json`, makePackageJson(spec), { overwrite: true })) === 'write')
    changed.push('package.json')
  if ((await writeIfAbsent(`${spec.dir}/tsconfig.json`, JSON.stringify(tsconfigFor(), null, 2) + '\n', { overwrite: true })) === 'write')
    changed.push('tsconfig.json')
  if ((await writeIfAbsent(`${spec.dir}/vitest.config.ts`, vitestFor(projectName), { overwrite: true })) === 'write')
    changed.push('vitest.config.ts')

  // src / tests 目录占位（不写 index.ts，避免覆盖成员的真实实现）
  await mkdir(join(ROOT, spec.dir, 'src'), { recursive: true })
  await mkdir(join(ROOT, spec.dir, 'tests'), { recursive: true })

  report.push(`${spec.name.padEnd(28)} ${changed.join(' ') || '（无变化）'}`)
}

console.log('脚手架生成完成：')
for (const line of report) console.log('  ' + line)
console.log('\n注意：src/index.ts 不自动生成，由各包负责人编写。')
