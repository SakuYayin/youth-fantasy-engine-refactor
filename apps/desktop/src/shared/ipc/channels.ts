import type {
  AiCompleteInput,
  AiCompleteOutput,
  BackupCreateInput,
  BackupCreateOutput,
  BackupListOutput,
  BackupRestoreInput,
  BackupRestoreOutput,
  BackupVerifyInput,
  BackupVerifyOutput,
  DocumentCreateInput,
  DocumentDeleteInput,
  DocumentGetInput,
  DocumentTreeInput,
  DocumentUpdateInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectListInput,
  ProjectListOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  SaveDraftInput,
  SettingsEntityGetInput,
  SettingsEntityListInput,
  SettingsEntitySaveInput,
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
  'listProjects',
  'updateProject',
  'deleteProject',
  'createDocument',
  'updateDocument',
  'deleteDocument',
  // 备份/恢复：路径由主进程决定（渲染层不传任意路径），见 backup-adapter.mjs
  'backupCreate',
  'backupList',
  'backupVerify',
  'backupRestore',
  'systemStatus',
  'listSettingsEntities',
  'getSettingsEntity',
  'saveSettingsEntity',
  // AI 走主进程：渲染层 CSP 是 connect-src 'none'，模型请求只能在 main 里发。
  'aiComplete',
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

/** method → 请求 payload 类型（与 @yfe/contracts 输入一一对应，不自造 DTO）。 */
export interface IpcRequestMap {
  saveDraft: SaveDraftInput;
  listDocumentTree: DocumentTreeInput;
  getDocument: DocumentGetInput;
  createProject: ProjectCreateInput;
  listProjects: ProjectListInput;
  updateProject: ProjectUpdateInput;
  deleteProject: ProjectDeleteInput;
  createDocument: DocumentCreateInput;
  updateDocument: DocumentUpdateInput;
  deleteDocument: DocumentDeleteInput;
  backupCreate: BackupCreateInput;
  backupList: null;
  backupVerify: BackupVerifyInput;
  backupRestore: BackupRestoreInput;
  systemStatus: null;
  listSettingsEntities: SettingsEntityListInput;
  getSettingsEntity: SettingsEntityGetInput;
  saveSettingsEntity: SettingsEntitySaveInput;
  aiComplete: AiCompleteInput;
}

/** method → 响应 value 类型。systemStatus 直接返回 SystemStatusOutput，其余返回契约输出对象。 */
export interface IpcResponseMap {
  saveDraft: { revision: string; draftSequence: number; charCount: number; savedAt: string };
  listDocumentTree: unknown;
  getDocument: unknown;
  createProject: unknown;
  listProjects: ProjectListOutput;
  updateProject: ProjectUpdateOutput;
  deleteProject: { projectId: string; revision: string };
  createDocument: unknown;
  updateDocument: unknown;
  deleteDocument: unknown;
  backupCreate: BackupCreateOutput;
  backupList: BackupListOutput;
  backupVerify: BackupVerifyOutput;
  backupRestore: BackupRestoreOutput;
  systemStatus: SystemStatusOutput;
  listSettingsEntities: unknown;
  getSettingsEntity: unknown;
  saveSettingsEntity: unknown;
  aiComplete: AiCompleteOutput;
}
