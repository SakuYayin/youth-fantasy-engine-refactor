/**
 * 联网检索 · **类型与常量**（冻结契约的一部分，零实现）
 *
 * 【真源】上游 `_upstream_tmp/youth-fantasy-engine-main/src/lib/ai/webSearch.ts`（336 行）。
 *   本文件**逐字**抄该文件 `:29-119` 的 7 个类型与 5 个常量。
 *
 * 🔴 函数实现**不进本包**：`webSearch` / `buildSearchRequest` / `harvestItems` /
 *    `renderSearchResults` / `searchBlockedReason` 全部留在宿主，由宿主经
 *    `TavernSearchPort`（见 `ports.ts`）整个模块对象注入。理由：`webSearch` 的唯一宿主面是
 *    模块级 `defaultTransport`（`:206`，桌面走主进程、其余走浏览器 `fetch`），宿主本来就得
 *    自己实现它；包内再抄一份会产生**双份实现漂移**（上游改协议、本包副本不跟随）。
 *    上游早已把注入点设计好（`deps.transport`，`:281`），宿主直传即可零适配。
 *
 * 因此本文件**只有类型与常量，没有一行函数实现**——`DraftMaterialArgs.searchFn`
 * 在 `ports.ts` 里写成 `TavernSearchPort['webSearch']`（与上游 `typeof webSearch` 结构等价），
 * 不需要在这里声明一个函数值。
 */

// ==================== 类型（逐字抄自上游 webSearch.ts:29-105） ====================

export type SearchEngine = 'bocha' | 'searxng' | 'custom'

export type SearchSettings = {
  /**
   * 检索方式：
   *   · `off`   —— 不联网。只用模型已有知识 + 作者粘贴的参考素材（零配置，永远可用）
   *   · `model` —— 模型自带联网（适用于支持联网的模型/中转，检索发生在服务商那一侧）
   *   · `api`   —— 由我们调用下面配的搜索接口，把结果喂给模型
   */
  mode: 'off' | 'model' | 'api'
  engine: SearchEngine
  /** 接口地址（engine='searxng' 留空即用本地默认；engine='bocha' 留空即用博查默认地址） */
  endpoint: string
  apiKey: string
  /** 每次取几条结果（1–10） */
  topK: number
}

export type SearchItem = {
  title: string
  url: string
  /** 摘要（可能为空 —— 有些接口只给标题） */
  snippet: string
}

export type SearchOutcome = {
  /** 实际用上了检索结果 */
  used: boolean
  /** 用哪个引擎查的（给界面显示） */
  engine: string
  /** 实际发出的检索词 */
  query: string
  results: SearchItem[]
  /** 失败原因（used=false 时给界面看）。**不静默** —— 作者必须知道这次没查成 */
  error?: string
}

/** 一次请求的描述。**构造与发送分开** —— 构造是纯函数，可以脱离网络单测 */
export type SearchRequest = {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/** 一次请求的结果。失败也照常返回（**不抛**），由调用方如实上报 */
export type TransportResult =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string }

/**
 * 发送器：把一次请求发出去、取回响应文本。
 * 默认实现在桌面版走主进程、其余走浏览器 fetch；测试可注入桩。
 */
export type SearchTransport = (req: SearchRequest, signal?: AbortSignal) => Promise<TransportResult>

// ==================== 常量（逐字抄自上游 webSearch.ts:47-119） ====================

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  mode: 'off',
  engine: 'bocha',
  endpoint: '',
  apiKey: '',
  topK: 5,
}

/** 博查的默认接口（实测响应带 `Access-Control-Allow-Origin: *`，浏览器可直连；需要密钥） */
export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/**
 * 自建 SearXNG 的默认地址（免费、无密钥、无次数限制）。
 * ⚠️ 三处前提，缺一个都查不到东西：
 *   ① `settings.yml` 里 `search.formats` 要包含 `json` —— 官方默认**只有 html**，不加接口直接 403；
 *   ② `limiter` 要关掉 —— 开着它只放行「像浏览器」的请求，我们的调用会被判成机器人回 429；
 *   ③ 端口要与你的端口映射一致（这里默认 8888：官方 docker 文档示例用的就是这个）。
 * 地址里带 `{query}` 即按 **GET** 调用（SearXNG / Jina / Exa 这类都是 GET 取 JSON）。
 */
export const SEARXNG_ENDPOINT = 'http://127.0.0.1:8888/search?q={query}&format=json&language=zh-CN'

/** 检索方式的显示名（界面与日志共用一处，别各写各的） */
export const SEARCH_MODE_LABEL: Record<SearchSettings['mode'], string> = {
  off: '模型已有知识 + 粘贴素材',
  model: '模型自带联网',
  api: '搜索接口',
}

/** 引擎显示名 */
export const SEARCH_ENGINE_LABEL: Record<SearchEngine, string> = {
  bocha: '博查',
  searxng: 'SearXNG',
  custom: '自定义接口',
}