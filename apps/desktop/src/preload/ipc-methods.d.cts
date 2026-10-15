/**
 * `../preload/ipc-methods.cjs` 的类型声明（CommonJS 形态）。
 *
 * 为什么要单独写：`.cjs` 是沙箱化 preload 用的运行时纯 JS 副本
 * （见 docs/adr/0003-preload-sandbox-cjs.md）。测试用 TypeScript 导入它时
 * 需要显式声明，而不是为此把全仓测试配置改成 allowJs。
 */
declare const ipcMethodsModule: {
  readonly IPC_METHODS: readonly [
    'saveDraft',
    'listDocumentTree',
    'getDocument',
    'createProject',
    'createDocument',
    'systemStatus',
    'listSettingsEntities',
    'getSettingsEntity',
    'saveSettingsEntity',
  ];
};

export = ipcMethodsModule;
