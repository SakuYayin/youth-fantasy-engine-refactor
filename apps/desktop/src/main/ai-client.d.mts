/**
 * `./ai-client.mjs` 的类型声明。
 *
 * 为什么单独写声明而不是开 allowJs：这里的输入是**未校验的用户配置**、
 * 返回是**跨进程信封**（`{ ok, value } | { ok:false, code, message, detail }`），
 * 渲染层按 `code` 分支渲染。靠 JS 推断出来的类型既不稳定也读不出意图。
 * 实现改动与本文件不一致时，`npm run typecheck:tests` 会立刻报错。
 *
 * 🔴 入参为什么是 `unknown`：`validateAiRequest` 是**校验器**，它的存在意义就是
 *    接住任意输入；`complete` 内部先校验、失败时返回错误信封而**绝不抛异常**
 *    （见实现头注释）。把入参收紧成「合法形状」会让类型与运行时语义相反——
 *    调用方传入畸形载荷本来就是被支持的路径（用例专门覆盖 `config: {}`、
 *    `role: 'tool'` 等）。合法形状写在下方的 `AiCompleteRequest` 里供调用方
 *    自查（`satisfies AiCompleteRequest`），但不用它挡住运行时校验。
 *
 * 风格与同目录的 `close-guard.d.mts` / `service-host.d.mts` 一致。
 */

/**
 * 错误码闭集（7 个，与 `@yfe/contracts` 的 `AI_` 组一一对应）。
 *
 * 注：运行时 `complete` 只会返回其中 6 个——`AI_CANCELLED` 属于契约闭集，
 * 留待调用方（渲染层取消新请求取代旧请求）使用。
 */
export type AiClientErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH_FAILED'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_RESPONSE_MALFORMED'
  | 'AI_CANCELLED';

/**
 * 一条对话消息。
 *
 * `role` 刻意只留 `user` / `assistant`：system 走 `system` 字段，
 * 由 main 进程拼成 `messages[0]`，渲染层不自己拼系统消息。
 */
export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** 模型配置三要素（`isAiConfigComplete` 要求齐全且非空白，`baseUrl` 必须 http(s)）。 */
export interface AiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 采样温度；会被夹到 `[0, 2]`。 */
  readonly temperature?: number;
  /** 单次请求 `max_tokens`；缺省 2048。 */
  readonly maxTokens?: number;
  /** 单次请求超时（毫秒）；缺省 180000，上限 600000。 */
  readonly timeoutMs?: number;
}

/** 一次补全请求的**合法**形状（供调用方自查；不是入参约束）。 */
export interface AiCompleteRequest {
  readonly config: AiConfig;
  /** 非空时插到 `messages` 最前面。 */
  readonly system?: string;
  readonly messages: readonly AiMessage[];
}

/** 用量：上游 snake_case 已换成 camelCase，且只为有限数值建键。 */
export type AiUsage = Readonly<Record<string, number>>;

/**
 * `validateAiRequest` 的失败描述；通过时返回 `null`。
 *
 * `detail` 只放标量（`reason` / `chars` / `timeoutMs` / `status`）；
 * 🔴 **绝不含 apiKey**。
 */
export interface AiRequestError {
  readonly code: AiClientErrorCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** `parseAiResponse` 的结果：成功带 `text`，失败带 `code` / `message`。 */
export interface AiParseResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly model?: string;
  readonly usage?: AiUsage;
  readonly code?: AiClientErrorCode;
  readonly message?: string;
}

/** 传给 fetch 的选项：客户端固定 `POST` + JSON + `AbortSignal`。 */
export interface AiFetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/**
 * 可注入的 fetch（测试用假实现替换全局 fetch）。
 *
 * 返回类型刻意是 `unknown`：客户端只按鸭子类型读 `ok` / `status` / `text()`，
 * 假实现不必满足 DOM 的 `Response`。
 */
export type AiFetchImpl = (url: string, init?: AiFetchInit) => Promise<unknown>;

export interface AiClientOptions {
  /** 缺省用全局 `fetch`。 */
  readonly fetchImpl?: AiFetchImpl;
}

/** `complete` 的信封：成功 `{ ok:true, value, ms }`，失败 `{ ok:false, code, message, detail? }`。 */
export interface AiCompleteResult {
  readonly ok: boolean;
  readonly value?: {
    readonly text: string;
    readonly model?: string;
    readonly usage?: AiUsage;
  };
  readonly code?: AiClientErrorCode;
  readonly message?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** 成功时从发请求到读完响应体的毫秒数。 */
  readonly ms?: number;
}

export interface AiClient {
  /** 在飞请求数（自检/测试用）。 */
  pendingCount(): number;
  /** 全部中止（优雅停机）；可重复调用，abort 抛错不阻断关闭。 */
  abortAll(): void;
  /** 一次补全；**绝不抛异常**，失败以 `{ ok:false, code, message, detail? }` 返回。 */
  complete(request: unknown): Promise<AiCompleteResult>;
}

/** 判断配置是否可用（三要素齐全才算配置过）；接受任意输入。 */
export declare function isAiConfigComplete(config: unknown): boolean;

/** 校验请求形状；返回 `null` 表示通过，否则 `{ code, message, detail }`。 */
export declare function validateAiRequest(request: unknown): AiRequestError | null;

/** 从 OpenAI 兼容响应体里提取文本与用量；解析不出按 `AI_RESPONSE_MALFORMED`。 */
export declare function parseAiResponse(bodyText: string): AiParseResult;

/** 构造 AI 客户端；`options.fetchImpl` 可注入假 fetch。 */
export declare function createAiClient(options?: AiClientOptions): AiClient;

/** 测试/白名单断言用：7 码闭集（已 `Object.freeze`）。 */
export declare const AI_CLIENT_ERROR_CODES: readonly AiClientErrorCode[];
