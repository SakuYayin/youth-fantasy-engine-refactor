# ADR 0006：渲染层架构与三份接口契约

- 状态：已接受（2026-10-15）
- 背景：用户 m04734 拍板「渲染层开工」「移动端按契约来」（即沿用 `docs/移动端技术栈选型.md` 的 uni-app x 蒸汽模式 + 契约层 `MobileDatabase`，不按纯工程评分改选）。
- 目的：在开写之前把**跨人协作的三份接口**钉死，避免并行子智能体各自发明一份（教训 R-44）。

## D1 渲染层形态

- Vue 3.5 + Vite 8；渲染进程保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- `index.html` 的 CSP **不得放宽**（`default-src 'none'; script-src 'self'; ...`）。新增外部资源一律走系统浏览器。
- 正文以**纯文本**为兼容基础；编辑器用 CodeMirror 6，且必须藏在 `EditorAdapter` 后面——将来替换编辑器不得改变保存与版本语义。
- 业务逻辑写在 `.ts` 里（可无头测试），`.vue` 只做渲染；桌面与 UI 使用 `vue-tsc` 检查模板，另有 `@vue/test-utils` 挂载测试。普通 tsc 测试入口保留 `.vue` 声明。

## D2 `@yfe/client-sdk`（新 workspace）

```ts
export interface ClientTransport {
  call(method: string, payload: unknown): Promise<unknown> // main 侧响应信封
}
export interface CreateClientOptions { readonly timeoutMs?: number }
export function createClient(transport: ClientTransport, options?: CreateClientOptions): RendererClient
```

`RendererClient` 的方法名与 `apps/desktop/src/shared/ipc/channels.ts` 的 `IPC_METHODS` **逐字一致**，参数与返回值直接用 `@yfe/contracts` 类型，不自造 DTO：

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `saveDraft` | `SaveDraftInput` | `SaveDraftOutput` |
| `listDocumentTree` | `DocumentTreeInput` | `DocumentTreeOutput` |
| `getDocument` | `DocumentGetInput` | `DocumentGetOutput` |
| `createProject` | `ProjectCreateInput` | `ProjectCreateOutput` |
| `createDocument` | `DocumentCreateInput` | `DocumentCreateOutput` |
| `systemStatus` | 无 | `SystemStatusOutput` |

语义：

1. **不抛异常**：返回 `Result<T>`（与用例层、持久层一致）。失败一律 `err(ErrorPayload)`。
2. 调用方拿到的 `ErrorPayload` **绝不含 `cause` / stack / SQLite 原文 / 绝对路径**（跨进程边界必须脱敏）。
3. 超时（默认 `timeoutMs = 15000`）→ `NETWORK_TIMEOUT`，`retryable: true`。
4. 响应信封畸形（非对象、`ok` 非布尔、失败缺 `code`）→ `INTERNAL_ERROR`，**绝不把畸形当成功**。
5. 白名单外的 `method` → `PERMISSION_METHOD_NOT_ALLOWED`；方法名不得绕过 preload 白名单。
6. 依赖只有 `@yfe/contracts`；**不得** import DOM / Electron / Vue。

## D3 `@yfe/ui`（新 workspace）

设计令牌集中在 `src/tokens.ts` 的 `designTokens`（颜色 / 间距 / 圆角 / 字体 / 层级），深色为默认；组件只吃令牌，不写魔法值。

组件名、props、事件固定如下（渲染层直接按这张表写）：

| 组件 | props | emits |
| --- | --- | --- |
| `YfeButton` | `{ label: string; variant?: 'primary' \| 'ghost' \| 'danger'; disabled?: boolean; loading?: boolean }` | `click` |
| `YfePanel` | `{ title?: string; dense?: boolean }` + 默认插槽 | — |
| `YfeTree` | `{ nodes: readonly YfeTreeNode[]; selectedId: string \| null; expandedIds: readonly string[] }` | `select(id)`、`toggle(id)` |
| `YfeStatusPill` | `{ status: YfeSaveStatus; detail?: string }` | — |
| `YfeDialog` | `{ open: boolean; title: string; confirmLabel: string; cancelLabel?: string; tone?: 'normal' \| 'danger' }` | `confirm`、`cancel` |
| `YfeToolbar` | `{ }` + 默认插槽 | — |

```ts
export interface YfeTreeNode {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly hasChildren: boolean
  readonly deleted?: boolean
  readonly current?: boolean
}
export type YfeSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'
```

- `YfeStatusPill` 的文案映射**只在组件内定义**（各处不得自造中文），本条是 D5 的执行手段。
- `YfeDialog` 必须支持 Esc 关闭与焦点陷阱。
- `@yfe/ui` **不** import `@yfe/contracts`：UI 只吃基础类型，避免被领域类型拖住（领域类型在渲染层转换）。

## D4 `EditorAdapter`

```ts
export interface EditorChange { readonly from: number; readonly to: number; readonly insert: string }
export interface EditorDecoration { readonly from: number; readonly to: number; readonly class?: string }

export interface EditorAdapter {
  open(options: { documentId: string; body: string; readOnly?: boolean }): void
  getBody(): string
  getSelection(): { from: number; to: number; text: string }
  applyTransaction(changes: readonly EditorChange[]): void
  undo(): boolean
  redo(): boolean
  flush(): Promise<void>
  decorate(ranges: readonly EditorDecoration[]): void
  registerCommand(name: string, run: () => boolean): () => void
  focus(): void
  onChange(handler: (body: string) => void): () => void
  dispose(): void
}
```

- 实现 `createCodeMirrorAdapter(host: HTMLElement, options?): EditorAdapter`，只用 `@codemirror/state` / `@codemirror/view` / `@codemirror/commands`。
- `docChanged` → `onChange(body)`：**每次键入只产生一个字符串**，不做大字符串双向绑定、不整段重建编辑器。
- `open()` 切文档时用 `setState` 重置 undo 历史（避免跨文档撤销把甲章内容插进乙章）。
- `flush()` 只把待派发的变更交给上层（保存前调用）；**编辑器自己不保存**。
- 输入法组合态（`composing`）期间不得被 `open()`/外部更新重置。

## D5 保存状态语义（UI 必须区分，不得合并）

| 内部状态 | 中文文案 | 说明 |
| --- | --- | --- |
| `saved` | 本地已保存 | `body === confirmedBody` |
| `dirty` | 有未保存修改 | 键入后、派发前 |
| `saving` | 保存中 | 有在途保存 |
| `error` | 保存失败 | 等用户 `retry()` 或下一次键入 |
| `conflict` | 冲突 | 外部版本与本地稿冲突，必须用户裁决 |
| `offline` | 离线（本地已保存） | **网络错误不得覆盖本地保存状态**，同步态另起一格显示 |

保存结果**只确认对应草稿序号**，迟到结果不得覆盖新稿（已由 `apps/desktop/src/renderer/state/draft-session.ts` 实现并有 21 条测试）。

## D6 不变量（评审必查）

1. 渲染进程不得 `import` 任何 `node:` 模块、不得直连 SQLite、不得自造 IPC 方法名。
2. 所有写入携带 `expectedRevision`；采用建议稿、解决冲突后必须重新校验版本。
3. 关窗/切章前必须 `flush()` 未提交草稿；`beforeunload` 同步 IPC 不得当日常保存手段。
4. 插件命令进命令面板，不为插件自动加常驻按钮。
5. 三平台快捷键按 Ctrl/Cmd 映射，命令用语义 ID。

## 已知残留

- 2026-10-15 审查后已接入 `vue-tsc`：桌面与 UI 的模板纳入类型门禁，并增加写作页挂载测试。
- Electron 44.7.2 已安装；本机 GUI 启动仍失败，因果来源未定位。`vite build`、组件测试与无 GUI 链路通过，真窗口验收仍为阻塞项。
