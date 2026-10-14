/**
 * `@yfe/contracts` —— 跨端共享契约的唯一出口。
 *
 * 设计约束（`01-总体架构.md`）：契约层只放 **Schema、DTO、错误码、协议常量**，
 * 不含业务逻辑、不依赖数据库、不依赖 Electron/浏览器 API，因此可以被桌面端、
 * 后端服务与（未来的）移动端同时引用而不产生循环依赖。
 *
 * 本包一旦冻结（P0 结束），变更必须走 ADR + 全量回归。
 */

export * from './ids.js'
export * from './errors.js'
export * from './version.js'
