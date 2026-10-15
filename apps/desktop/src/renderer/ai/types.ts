/**
 * AI 面板层类型（W7）。
 *
 * 模型请求只能在 main 进程发（渲染层 CSP `connect-src 'none'`），
 * 因此这里的 `AiPort` 只是「把请求交给主进程」的薄封装；
 * 错误码与 `@yfe/contracts` 的 AI_ 组一一对应。
 */

/** 一条对话消息（system 走独立字段，不在 messages 里拼）。 */
export interface AiMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface AiRequest {
  readonly system?: string
  readonly messages: readonly AiMessage[]
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface AiUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
}

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH_FAILED'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_RESPONSE_MALFORMED'
  | 'AI_CANCELLED'

/** AI 结果：失败也**不抛**，把脱敏后的错误码交给面板自己决定怎么呈现。 */
export type AiResult =
  | { readonly ok: true; readonly text: string; readonly usage?: AiUsage; readonly model?: string }
  | { readonly ok: false; readonly code: AiErrorCode; readonly message: string }

/** 依赖模型的面板统一从这里拿 AI 能力（不自己发请求、不自己读配置）。 */
export interface AiPort {
  /** 已加载的模型配置；未加载/未配置时为 null。 */
  getConfig(): AiModelConfig | null
  /** 三要素（baseUrl/model/apiKey）齐全才算配置过。 */
  configured(): boolean
  /** 从库里重读配置（保存后调用；面板切换到 AI 页签时也应调用）。 */
  reload(): Promise<boolean>
  /** 保存模型配置（走 settings_entities；apiKey 属敏感值，绝不进日志）。 */
  saveConfig(config: AiModelConfig): Promise<boolean>
  /** 一次补全。未配置时返回 `AI_NOT_CONFIGURED`，**不发起请求**。 */
  complete(request: AiRequest): Promise<AiResult>
}

/** 模型配置（存 `settings_entities`，模板 `panel:ai-config`）。 */
export interface AiModelConfig {
  /** 目前只有 `openai-compatible`。 */
  readonly provider: string
  /** OpenAI 兼容端点（含 `/v1`）。 */
  readonly baseUrl: string
  readonly model: string
  /** 敏感：只存本地库；绝不进日志/导出/错误载荷。 */
  readonly apiKey: string
  readonly temperature: number
  readonly maxTokens: number
  readonly timeoutMs: number
}
