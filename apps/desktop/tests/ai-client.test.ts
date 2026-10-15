/**
 * 主进程 AI 客户端的单测（apps/desktop/src/main/ai-client.mjs）。
 *
 * 用注入的假 fetch 覆盖：
 * - 请求形状校验（AI_NOT_CONFIGURED / AI_RESPONSE_MALFORMED 细分 reason）；
 * - OpenAI 兼容 POST（baseUrl 去尾斜杠、Bearer 头、stream:false）；
 * - 状态码映射（401/403→AI_AUTH_FAILED、429→AI_RATE_LIMITED、其它→AI_UPSTREAM_ERROR）；
 * - 超时中止→AI_TIMEOUT；网络错误→AI_UPSTREAM_ERROR；
 * - 响应解析（choices[0].message.content、usage 换 camelCase）；
 * - pendingCount/abortAll。
 * 🔴 apiKey 只出现在请求头里，错误 message/detail 绝不能带它。
 *
 * 取值风格与既有 .mjs 集成测试一致：联合返回用 `as` 展开包（TS 对 JS 推断不做窄化）。
 */

import { describe, expect, it } from 'vitest'

import {
  AI_CLIENT_ERROR_CODES,
  createAiClient,
  isAiConfigComplete,
  parseAiResponse,
  validateAiRequest,
} from '../src/main/ai-client.mjs'

interface AiClientResultBag {
  ok: boolean
  value?: { text?: string; model?: string; usage?: Record<string, unknown> }
  code?: string
  message?: string
  detail?: Record<string, unknown>
  ms?: number
}

interface RecordedRequest {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
}

const VALID_CONFIG = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-secret-value',
  model: 'glm-5.3-flash',
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    config: { ...VALID_CONFIG },
    messages: [{ role: 'user', content: '你好' }],
    ...overrides,
  }
}

function jsonFetch(status: number, body: unknown): { impl: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  return {
    requests,
    impl: async (url: string, init?: unknown) => {
      requests.push({ url, init: (init ?? {}) as RecordedRequest['init'] })
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
    },
  }
}

function expectNoSecret(result: AiClientResultBag): void {
  expect(JSON.stringify(result)).not.toContain('sk-secret-value')
}

describe('isAiConfigComplete / validateAiRequest', () => {
  it('三要素齐全才算配置过', () => {
    expect(isAiConfigComplete(VALID_CONFIG)).toBe(true)
    expect(isAiConfigComplete({ ...VALID_CONFIG, apiKey: '  ' })).toBe(false)
    expect(isAiConfigComplete({ ...VALID_CONFIG, model: '' })).toBe(false)
    expect(isAiConfigComplete({ ...VALID_CONFIG, baseUrl: 'ftp://x' })).toBe(false)
    expect(isAiConfigComplete(null)).toBe(false)
  })

  it('请求形状校验的细分 reason', () => {
    expect(validateAiRequest(makeRequest())).toBeNull()
    expect(validateAiRequest(null)?.code).toBe('AI_NOT_CONFIGURED')
    expect(validateAiRequest(makeRequest({ config: {} }))?.detail).toMatchObject({ reason: 'config_incomplete' })
    expect(validateAiRequest(makeRequest({ messages: [] }))?.detail).toMatchObject({ reason: 'messages_empty' })
    expect(
      validateAiRequest(makeRequest({ messages: [{ role: 'tool', content: 'x' }] }))?.detail,
    ).toMatchObject({ reason: 'message_shape' })
    const big = 'x'.repeat(400_001)
    const tooLarge = validateAiRequest(makeRequest({ messages: [{ role: 'user', content: big }] }))
    expect(tooLarge?.code).toBe('AI_RESPONSE_MALFORMED')
    expect(tooLarge?.detail).toMatchObject({ reason: 'payload_too_large' })
  })
})

describe('parseAiResponse', () => {
  it('OpenAI 兼容体：取 choices[0].message.content，usage 换 camelCase', () => {
    const parsed = parseAiResponse(
      JSON.stringify({
        model: 'glm-5.3-flash',
        choices: [{ message: { content: '你好，世界' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.text).toBe('你好，世界')
    expect(parsed.model).toBe('glm-5.3-flash')
    expect(parsed.usage).toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it('非法 JSON / 无文本都按 AI_RESPONSE_MALFORMED', () => {
    expect(parseAiResponse('not-json').code).toBe('AI_RESPONSE_MALFORMED')
    expect(parseAiResponse(JSON.stringify({ choices: [] })).code).toBe('AI_RESPONSE_MALFORMED')
  })
})

describe('createAiClient.complete（假 fetch）', () => {
  it('成功：POST 到去尾斜杠的 /chat/completions，Bearer 头带 key，stream:false', async () => {
    const { impl, requests } = jsonFetch(200, {
      model: 'glm-5.3-flash',
      choices: [{ message: { content: '回复' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    })
    const client = createAiClient({ fetchImpl: impl })
    const result = (await client.complete(makeRequest({ system: '你是助手' }))) as AiClientResultBag
    expect(result.ok).toBe(true)
    expect(result.value?.text).toBe('回复')
    expect(result.value?.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
    expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(requests.length).toBe(1)
    expect(requests[0]?.url).toBe('https://api.example.com/v1/chat/completions')
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.headers?.authorization).toBe('Bearer sk-secret-value')
    const body = JSON.parse(requests[0]?.init.body ?? '{}') as {
      model: string
      messages: { role: string; content: string }[]
      max_tokens: number
      stream: boolean
    }
    expect(body.model).toBe('glm-5.3-flash')
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(2048)
  })

  it('未配置/畸形请求不发网络请求', async () => {
    const { impl, requests } = jsonFetch(200, {})
    const client = createAiClient({ fetchImpl: impl })
    const notConfigured = (await client.complete(makeRequest({ config: {} }))) as AiClientResultBag
    expect(notConfigured.ok).toBe(false)
    expect(notConfigured.code).toBe('AI_NOT_CONFIGURED')
    const malformed = (await client.complete(makeRequest({ messages: [{ role: 'tool', content: 'x' }] }))) as AiClientResultBag
    expect(malformed.ok).toBe(false)
    expect(malformed.code).toBe('AI_RESPONSE_MALFORMED')
    expect(requests.length).toBe(0)
  })

  it('401/403→AI_AUTH_FAILED、429→AI_RATE_LIMITED、500→AI_UPSTREAM_ERROR，message 不含 apiKey', async () => {
    for (const [status, code] of [
      [401, 'AI_AUTH_FAILED'],
      [403, 'AI_AUTH_FAILED'],
      [429, 'AI_RATE_LIMITED'],
      [500, 'AI_UPSTREAM_ERROR'],
    ] as const) {
      const { impl } = jsonFetch(status, { error: { message: '上游拒绝' } })
      const client = createAiClient({ fetchImpl: impl })
      const result = (await client.complete(makeRequest())) as AiClientResultBag
      expect(result.ok).toBe(false)
      expect(result.code).toBe(code)
      expectNoSecret(result)
    }
  })

  it('fetch 抛错（网络不可达）→ AI_UPSTREAM_ERROR', async () => {
    const client = createAiClient({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const result = (await client.complete(makeRequest())) as AiClientResultBag
    expect(result.ok).toBe(false)
    expect(result.code).toBe('AI_UPSTREAM_ERROR')
    expectNoSecret(result)
  })

  it('超时：请求被中止并返回 AI_TIMEOUT', async () => {
    const client = createAiClient({
      fetchImpl: (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    })
    const result = (await client.complete(makeRequest({ config: { ...VALID_CONFIG, timeoutMs: 30 } }))) as AiClientResultBag
    expect(result.ok).toBe(false)
    expect(result.code).toBe('AI_TIMEOUT')
    expect(client.pendingCount()).toBe(0)
  })

  it('abortAll：在飞请求被中止、pendingCount 归零', async () => {
    const aborted: string[] = []
    const client = createAiClient({
      fetchImpl: (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push('x')
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    })
    const pending = client.complete(makeRequest()) as Promise<AiClientResultBag>
    expect(client.pendingCount()).toBe(1)
    client.abortAll()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(aborted.length).toBe(1)
    expect(client.pendingCount()).toBe(0)
  })

  it('AI_CLIENT_ERROR_CODES 是 7 码闭集', () => {
    expect(AI_CLIENT_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'AI_NOT_CONFIGURED',
        'AI_AUTH_FAILED',
        'AI_RATE_LIMITED',
        'AI_TIMEOUT',
        'AI_UPSTREAM_ERROR',
        'AI_RESPONSE_MALFORMED',
        'AI_CANCELLED',
      ]),
    )
    expect(AI_CLIENT_ERROR_CODES.length).toBe(7)
  })
})
