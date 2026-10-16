/**
 * 【移植说明】本文件移植自上游 `src/lib/tavern/params.ts`（逐行移植）。
 *
 * · 解决什么问题：把「模式默认 → 角色参数 → 会话参数」多层采样参数逐层覆盖成一份完整参数
 *   （`resolveParams`），再把内部驼峰字段名翻译成 Ollama `/api/chat` 的 options 字段名
 *   （`toOllamaOptions`）——「重复惩罚」正是在这一步由 `repeatPenalty` 改名为 `repeat_penalty`。
 * · 行为差异：**无**。仅两处机械改动：
 *   ① import 路径 `@/lib/tavern/types` → `./types.js`（NodeNext 风格，相对 import 带 .js 后缀）；
 *   ② 覆盖循环里上游的 `Object.entries(layer) as [keyof TavernParams, unknown][]`
 *      改写成 `... as [keyof TavernParams, unknown][]`，判据由
 *      `v !== undefined && v !== null && Number.isFinite(v)` 改写成
 *      `typeof v === 'number' && Number.isFinite(v)` —— 本仓禁止 `any`，`unknown` 必须显式收窄；
 *      两者运行时等价（`Number.isFinite` 对所有非 number 原语一律 false，且不抛错）。
 * · 注意：本层**不做数值区间收敛**（不夹温度 / top_p 上下限）—— 这里只丢弃非有限值，
 *   区间判定归 `settings.ts` / `paramGuide.ts`；移植时不要顺手加 clamp。
 * · 临时实现：无。
 */
/**
 * 酒馆模式 · 采样参数（继承式覆盖）
 *
 * 设计依据：方案 §4.9。
 *
 * 【继承链】会话参数 → 角色参数 → 模式默认 → 全局默认，**逐层覆盖**（越靠后越优先）。
 * 调用方按需传层即可，未传的层自动跳过。
 *
 * ★ 抄参数时最容易抄错的一处（方案 §4.9 专门标注）：
 *   界面叫「重复惩罚」，底层字段是 `repetition_penalty`，而到 Ollama 那边叫 `repeat_penalty`
 *   ——少了 "ition"。同一个参数、两个名字，别弄混。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { TAVERN_DEFAULTS, type TavernParams } from './types.js'

export type ResolvedParams = Required<TavernParams>

/**
 * 逐层覆盖出最终参数。
 * @param mode 'plot'（剧情，温度 0.9）/ 'free'（自由，温度 0.95 —— 更松）
 * @param layers 从低优先级到高优先级依次传入（如 角色参数, 会话参数）
 */
export function resolveParams(mode: 'plot' | 'free', ...layers: (TavernParams | undefined)[]): ResolvedParams {
  const out: ResolvedParams = { ...TAVERN_DEFAULTS[mode] }
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer) as [keyof TavernParams, unknown][]) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}

/**
 * 把解析后的参数翻译成 Ollama 原生 /api/chat 的 options 字段名。
 * ⚠️ 这里就是「重复惩罚」改名的地方：内部 repeatPenalty → Ollama 的 repeat_penalty。
 *
 * ⚠️ 两把「治复读」的旋钮（2026-09-16 新增）必须**显式下发**才有意义：
 *   · `repeat_last_n` —— 不传时 Ollama 用自带默认 **64 词元 ≈ 50 个汉字**，
 *     而它同时是 repeat_penalty / frequency_penalty / presence_penalty 三者的回看窗口，
 *     射程只有半句话 → 跨轮复读罚不到（见 GUIDE_REPEAT_LAST_N）。
 *   · `frequency_penalty` —— 不传时默认 **0（完全关闭）**，按词频扣分这件事根本没发生。
 */
export function toOllamaOptions(p: ResolvedParams): Record<string, number> {
  return {
    temperature: p.temperature,
    top_p: p.topP,
    top_k: p.topK,
    repeat_penalty: p.repeatPenalty,
    frequency_penalty: p.frequencyPenalty,
    repeat_last_n: p.repeatLastN,
    presence_penalty: p.presencePenalty,
    // 显式传 num_ctx：不传时 Ollama 会按全局 OLLAMA_CONTEXT_LENGTH（可能 128K）加载，
    // 显存占用远超预期（方案 §9.3）
    num_ctx: p.numCtx,
  }
}
