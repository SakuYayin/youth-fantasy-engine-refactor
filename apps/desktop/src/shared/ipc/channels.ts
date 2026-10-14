import type {
  DocumentCreateInput,
  DocumentGetInput,
  DocumentTreeInput,
  ProjectCreateInput,
  SaveDraftInput,
  SystemStatusOutput,
} from '@yfe/contracts';

/**
 * 渲染进程 → main 进程的 IPC 方法白名单。
 * 只允许列在这里的方法通过 preload 暴露；新增方法必须同时补测试。
 *
 * 方法名即 db-worker 分派的 method 值，两端共用这一张表，禁止另起一套字符串。
 */
export const IPC_METHODS = [
  'saveDraft',
  'listDocumentTree',
  'getDocument',
  'createProject',
  'createDocument',
  'systemStatus',
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

/** method → 请求 payload 类型（与 @yfe/contracts 输入一一对应，不自造 DTO）。 */
export interface IpcRequestMap {
  saveDraft: SaveDraftInput;
  listDocumentTree: DocumentTreeInput;
  getDocument: DocumentGetInput;
  createProject: ProjectCreateInput;
  createDocument: DocumentCreateInput;
  systemStatus: null;
}

/** method → 响应 value 类型。systemStatus 直接返回 SystemStatusOutput，其余返回契约输出对象。 */
export interface IpcResponseMap {
  saveDraft: { revision: string; draftSequence: number; charCount: number; savedAt: string };
  listDocumentTree: unknown;
  getDocument: unknown;
  createProject: unknown;
  createDocument: unknown;
  systemStatus: SystemStatusOutput;
}
