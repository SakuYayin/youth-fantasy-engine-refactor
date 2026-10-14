/**
 * `@yfe/domain` —— 领域内核索引。
 *
 * 该包必须保持**零 IO 依赖**（设计文档 `01-总体架构.md` 模块依赖禁令）：
 * 不得 import Electron、Vue、Fastify、Node `fs`/`path`、任何 SQL 驱动、DOM，
 * 也不得读 `process.env`。这一层要在桌面、后端与手机原生运行时里都能跑。
 *
 * 唯一允许的依赖是 `@yfe/contracts`（纯类型与纯函数，无副作用）。
 *
 * 子模块：
 * - `@yfe/domain/text`：正文归一化、字素簇扫描、字数统计
 * - `@yfe/domain/orderKey`：分数索引排序键
 * - `@yfe/domain/merge`：合并判定（不做自动正文合并）
 */

export * from './text/index.js'
export * from './orderKey/index.js'
export * from './merge/index.js'
