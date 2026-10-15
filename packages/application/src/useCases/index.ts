/**
 * 用例层 barrel：HTTP 路由、IPC handler、CLI 都从这里取用例函数。
 *
 * 约定：每个用例都是 `(deps, input) => Promise<Result<Output>>`，
 * **不抛异常**（异常在用例内被归一为契约错误），**不读全局状态**（时钟/ID/持久化全靠注入）。
 */

export * from './saveDraft.js'
export * from './createProject.js'
export * from './listProjects.js'
export * from './updateProject.js'
export * from './deleteProject.js'
export * from './createDocument.js'
export * from './getDocument.js'
export * from './updateDocument.js'
export * from './deleteDocument.js'
export * from './listDocumentTree.js'
export * from './listSettingsEntities.js'
export * from './getSettingsEntity.js'
export * from './saveSettingsEntity.js'
export * from './systemStatus.js'
