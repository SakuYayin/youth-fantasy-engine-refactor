'use strict';
/**
 * AI 模型客户端（main 进程）。
 *
 * 🔴 为什么在 main：渲染层 CSP 是 `connect-src 'none'`（绝不允许放宽），
 *    模型请求只能在 main 里发；结果经 IPC 回传给面板。
 *
 * 协议：OpenAI 兼容 `POST {baseUrl}/chat/completions`
 * （旧版支持的就是 OpenAI 兼容端点；`baseUrl` 已含 `/v1`，这里只拼 `/chat/completions`）。
 *
 * 错误码（与 `@yfe/contracts` 的 AI_ 组一一对应）：
 * - `AI_NOT_CONFIGURED`      config 缺字段（baseUrl/model/apiKey）——预期分支
 * - `AI_AUTH_FAILED`         上游 401/403
 * - `AI_RATE_LIMITED`        上游 429
 * - `AI_TIMEOUT`             超过 timeoutMs
 * - `AI_RESPONSE_MALFORMED`  2xx 但解析不出文本
 * - `AI_UPSTREAM_ERROR`      其它非 2xx / 网络异常
 * - `AI_CANCELLED`           调用方中止（shutdown / 新请求取代）
 *
 * 🔴 敏感值纪律（11:44）：`apiKey` 只在请求头里出现一次；
 *    **绝不**进日志、错误 message、错误 detail 与任何回显。
 *    detail 只放标量（`status` / `reason` / `upstream` 域名），错误 message 截断且剥离 key。
 */

const DEFAULT_TIMEOUT_MS = 180_000; // 长生成远大于 IPC 默认 15s；单次请求可覆盖
const DEFAULT_MAX_TOKENS = 2048;
const MAX_MESSAGE_CHARS = 400_000; // 单请求正文上限（防误把整本书粘进来一次发出去）
const ERROR_MESSAGE_MAX = 300;

const AI_ERROR_CODES = Object.freeze([
  'AI_NOT_CONFIGURED',
  'AI_AUTH_FAILED',
  'AI_RATE_LIMITED',
  'AI_TIMEOUT',
  'AI_UPSTREAM_ERROR',
  'AI_RESPONSE_MALFORMED',
  'AI_CANCELLED',
]);

/** 哪些 HTTP 状态映射到哪个 AI 错误码。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AI_AUTH_FAILED';
  if (status === 429) return 'AI_RATE_LIMITED';
  return 'AI_UPSTREAM_ERROR';
}

/** 从上游错误体里提取一句可读信息；剥掉任何像 key 的长 token。 */
function extractUpstreamMessage(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return '';
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText.replace(/\s+/g, ' ').slice(0, ERROR_MESSAGE_MAX);
  }
  const candidates = [parsed?.error?.message, parsed?.message, parsed?.error];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.replace(/\s+/g, ' ').slice(0, ERROR_MESSAGE_MAX);
    }
  }
  return '';
}

/** 判断配置是否可用（三要素齐全才算配置过）。 */
export function isAiConfigComplete(config) {
  return (
    config !== null &&
    typeof config === 'object' &&
    typeof config.baseUrl === 'string' &&
    /^https?:\/\//i.test(config.baseUrl) &&
    typeof config.model === 'string' &&
    config.model.trim().length > 0 &&
    typeof config.apiKey === 'string' &&
    config.apiKey.trim().length > 0
  );
}

/** 校验请求形状；返回 null 或 `{ code, message, detail }`。 */
export function validateAiRequest(request) {
  if (request === null || typeof request !== 'object') {
    return { code: 'AI_NOT_CONFIGURED', message: 'AI 请求载荷缺失', detail: { reason: 'payload_not_object' } };
  }
  if (!isAiConfigComplete(request.config)) {
    return {
      code: 'AI_NOT_CONFIGURED',
      message: '尚未配置可用的模型（需要 baseUrl / model / apiKey）',
      detail: { reason: 'config_incomplete' },
    };
  }
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { code: 'AI_NOT_CONFIGURED', message: '对话消息为空', detail: { reason: 'messages_empty' } };
  }
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== 'object' ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string'
    ) {
      return {
        code: 'AI_RESPONSE_MALFORMED',
        message: '对话消息形状非法（role 必须是 user/assistant，content 必须是字符串）',
        detail: { reason: 'message_shape' },
      };
    }
  }
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0) +
    (typeof request.system === 'string' ? request.system.length : 0);
  if (totalChars > MAX_MESSAGE_CHARS) {
    return {
      code: 'AI_RESPONSE_MALFORMED',
      message: `对话内容超过单次请求上限（${MAX_MESSAGE_CHARS} 字符）`,
      detail: { reason: 'payload_too_large', chars: totalChars },
    };
  }
  return null;
}

/** 从 OpenAI 兼容响应体里提取文本与用量；解析不出按 AI_RESPONSE_MALFORMED。 */
export function parseAiResponse(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'AI_RESPONSE_MALFORMED', message: '上游响应不是合法 JSON' };
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const text =
    typeof choice?.message?.content === 'string'
      ? choice.message.content
      : typeof parsed?.content === 'string'
        ? parsed.content
        : null;
  if (text === null) {
    return { ok: false, code: 'AI_RESPONSE_MALFORMED', message: '上游响应里没有可读的补全文本' };
  }
  const usage = {};
  if (Number.isFinite(parsed?.usage?.prompt_tokens)) usage.promptTokens = parsed.usage.prompt_tokens;
  if (Number.isFinite(parsed?.usage?.completion_tokens)) usage.completionTokens = parsed.usage.completion_tokens;
  const out = { ok: true, text };
  if (typeof parsed?.model === 'string' && parsed.model.length > 0) out.model = parsed.model;
  if (Object.keys(usage).length > 0) out.usage = usage;
  return out;
}

/**
 * 构造 AI 客户端。
 *
 * @param options.fetchImpl 可注入的 fetch（测试用假实现）；默认全局 fetch
 */
export function createAiClient(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;

  /** 在飞请求（shutdown 时全部中止）。 */
  const inFlight = new Set();

  return {
    /** 正在进行的请求数（自检/测试用）。 */
    pendingCount() {
      return inFlight.size;
    },
    /** 停机时全部中止（优雅停止）。 */
    abortAll() {
      for (const controller of inFlight) {
        try {
          controller.abort();
        } catch {
          // abort 抛错不阻断关闭
        }
      }
      inFlight.clear();
    },

    /**
     * 一次补全。返回 `{ ok:true, value } | { ok:false, code, message, detail? }`，
     * **绝不抛异常**（调用方直接把结果装进信封）。
     */
    async complete(request) {
      const invalid = validateAiRequest(request);
      if (invalid !== null) {
        return { ok: false, code: invalid.code, message: invalid.message, detail: invalid.detail };
      }
      const config = request.config;
      const timeoutMs =
        Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? Math.min(config.timeoutMs, 600_000)
          : DEFAULT_TIMEOUT_MS;
      const maxTokens = Number.isFinite(config.maxTokens) && config.maxTokens > 0
        ? Math.floor(config.maxTokens)
        : DEFAULT_MAX_TOKENS;
      const temperature = Number.isFinite(config.temperature)
        ? Math.min(Math.max(config.temperature, 0), 2)
        : undefined;

      const messages = [];
      if (typeof request.system === 'string' && request.system.length > 0) {
        messages.push({ role: 'system', content: request.system });
      }
      for (const message of request.messages) {
        messages.push({ role: message.role, content: message.content });
      }

      const controller = new AbortController();
      inFlight.add(controller);
      const started = Date.now();
      let response;
      let bodyText;
      try {
        response = await Promise.race([
          fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              max_tokens: maxTokens,
              ...(temperature === undefined ? {} : { temperature }),
              stream: false,
            }),
            signal: controller.signal,
          }),
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              try {
                controller.abort();
              } catch {
                // 已中止
              }
              const error = new Error('AI_TIMEOUT_INTERNAL');
              error.name = 'AI_TIMEOUT_INTERNAL';
              reject(error);
            }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        bodyText = await response.text();
      } catch (thrown) {
        const timedOut = thrown?.name === 'AI_TIMEOUT_INTERNAL' || thrown?.name === 'AbortError';
        return {
          ok: false,
          code: timedOut ? 'AI_TIMEOUT' : 'AI_UPSTREAM_ERROR',
          message: timedOut
            ? `模型请求超过 ${timeoutMs}ms，已中止`
            : '模型请求失败（网络不可达或连接被拒）',
          detail: timedOut ? { reason: 'timeout', timeoutMs } : { reason: 'network_error' },
        };
      } finally {
        inFlight.delete(controller);
      }

      if (!response.ok) {
        return {
          ok: false,
          code: codeForStatus(response.status),
          message: `模型服务返回 ${response.status}：${extractUpstreamMessage(bodyText) || '无详细信息'}`,
          detail: { status: response.status },
        };
      }
      const parsed = parseAiResponse(bodyText);
      if (!parsed.ok) {
        return { ok: false, code: parsed.code, message: parsed.message, detail: { status: response.status } };
      }
      const value = { text: parsed.text };
      if (parsed.model !== undefined) value.model = parsed.model;
      if (parsed.usage !== undefined) value.usage = parsed.usage;
      return { ok: true, value, ms: Date.now() - started };
    },
  };
}

/** 测试/白名单断言用。 */
export const AI_CLIENT_ERROR_CODES = AI_ERROR_CODES;
