/**
 * `src/saveDraft` —— 本地保存用例与草稿水位线。
 *
 * - {@link ./saveDraft.js}：`saveDraft(db, input, deps)`，一次写事务完成
 *   正文 + revision + 版本记录 + operation + outbox（设计文档 `06-数据与本地存储.md`）。
 * - {@link ./drafts.js}：`local_drafts` 的**单行水位线**读写与 `checkDraftSequence` 三态判定，
 *   负责幂等重放与「迟到回包不得覆盖新稿」。
 *
 * 🔴 两个模块的函数都不开事务、不关闭连接：连接由 DB 执行器独占持有，
 *    事务边界由 {@link saveDraft} 决定。
 */

export * from './drafts.js'
export * from './saveDraft.js'
