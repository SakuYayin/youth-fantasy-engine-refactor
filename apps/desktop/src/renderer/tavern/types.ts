/**
 * 酒馆（tavern）子系统共享类型 —— 预览版简化模型。
 *
 * 旧版酒馆是「引擎中的引擎」（55 个组件 + 15 个库文件，IndexedDB 存储）。
 * 预览版按「简化但可用」逐面板重建：
 * - 每个页签一个 panel-store 集合（模板 `panel:<tabId>`，values 里放 `{ items: [...] }`）；
 * - 记录 ID 由前端生成（newTavernId），仅用于面板内引用，绝不冒充实体的数据库 ID；
 * - 多轮对话/续写等 AI 能力一律走 `props.state.ai.complete()`（渲染层 CSP 禁网）。
 *
 * 类型只保留预览版必需字段；旧版更丰富的字段（变量系统/协议/脚本引擎内核）未迁移，
 * 迁移缺口由各面板在交付报告中如实记录。
 */

export interface TavernCardRecord {
  id: string;
  name: string;
  description: string;
  /** 性格与说话风格 */
  personality: string;
  /** 开场白（第一条 AI 消息） */
  firstMessage: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TavernWorldEntry {
  id: string;
  /** 触发关键词（顿号或逗号分隔） */
  keywords: string;
  content: string;
  enabled: boolean;
  order: number;
}

export interface TavernScriptRecord {
  id: string;
  name: string;
  /** 脚本内容（预览版纯文本，不执行） */
  code: string;
  enabled: boolean;
  note: string;
  updatedAt: string;
}

export interface TavernMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface TavernSessionRecord {
  id: string;
  title: string;
  /** 关联角色卡（TavernCardRecord.id），null 表示未选卡 */
  cardId: string | null;
  messages: TavernMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface TavernPlotScene {
  id: string;
  title: string;
  brief: string;
  messages: TavernMessage[];
  order: number;
}

export interface TavernReportRecord {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface TavernSettingsRecord {
  /** 对话模式：'chat'（常规）| 'story'（故事推进）| 'interview'（访谈） */
  mode: string;
  temperature: number;
  maxTokens: number;
  /** 送入模型上下文的最近消息条数 */
  contextMessages: number;
  /** 高级选项（自由文本键值，预览版不解析） */
  advanced: Record<string, string>;
}

/** 酒馆面板内记录 ID 工厂：仅用于 values JSON 内部引用。 */
export function newTavernId(prefix: string): string {
  const scope = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof scope.crypto?.randomUUID === 'function') {
    return `${prefix}_${scope.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** ISO 时间戳（酒馆记录用，与契约 UtcTimestamp 同形）。 */
export function tavernNow(): string {
  return new Date().toISOString();
}

/** 从角色卡 + 世界书条目组装 system 提示（自由对话/运行/情节共用）。 */
export function buildTavernSystemPrompt(
  card: TavernCardRecord | null,
  worldEntries: readonly TavernWorldEntry[],
): string {
  const parts: string[] = [];
  if (card !== null) {
    const lines = [`你在扮演「${card.name}」。`];
    if (card.description.trim() !== '') lines.push(`设定：${card.description.trim()}`);
    if (card.personality.trim() !== '') lines.push(`性格与说话风格：${card.personality.trim()}`);
    lines.push('始终以角色身份回复，不要跳出角色。');
    parts.push(lines.join('\n'));
  }
  const enabled = worldEntries.filter((entry) => entry.enabled && entry.content.trim() !== '');
  if (enabled.length > 0) {
    parts.push(`世界书设定：\n${enabled.map((entry) => `- ${entry.content.trim()}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** 取最近 N 条消息作为上下文（保持时间顺序）。 */
export function recentMessages(
  messages: readonly TavernMessage[],
  limit: number,
): TavernMessage[] {
  if (limit <= 0) return [];
  return messages.slice(Math.max(0, messages.length - limit));
}
