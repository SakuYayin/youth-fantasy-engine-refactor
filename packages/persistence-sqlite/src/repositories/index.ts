/**
 * Repository 层（P1-A3）—— `packages/persistence-sqlite/src/repositories/` 的对外出口。
 *
 * 每个实体一个文件，本文件只做 `export *` 汇总；**不导出 `internal.ts`**：
 * 里面的归属探针、排序键计算、JSON 校验都是实现细节，
 * 导出它们等于让调用方绕过乐观锁与 workspace 隔离自己拼 SQL。
 *
 * 设计约束（详见各文件头）：
 * - 所有函数**第一个参数是数据库句柄**，与 `saveDraft(db, input, deps)` 一致；
 * - workspace / project 一律由显式 `ReadContext` / `WriteContext` 传入，
 *   **没有**模块级"当前作品"单例（设计文档 10 的硬性禁令）；
 * - 跨 workspace 访问返回 `PERMISSION_WORKSPACE_MISMATCH`，不静默返回空；
 * - 软删默认不可见（`deleted <> 0` 过滤），取已删必须显式传 `includeDeleted: true`；
 * - 新建实体的 `revision` 与 `revision_seq = 1` 一起初始化，SaveDraft 的乐观锁才有基线；
 * - 错误一律是 `@yfe/contracts` 的 `Result` + `ERROR_CODES`。
 */

export * from './projects.js'
export * from './documents.js'
export * from './settingsEntities.js'
export * from './characters.js'
