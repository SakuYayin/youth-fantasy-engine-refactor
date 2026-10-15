/**
 * AI 端口实现：把「读配置 / 存配置 / 一次补全」收敛到一个对象上。
 *
 * 配置存 `settings_entities`（模板 `panel:ai-config`）——与面板状态同一张表、
 * 同一套用例（W6 打通的 `listSettingsEntities` / `saveSettingsEntity`），
 * 因此**零后端改动**。
 *
 * 三条纪律：
 * 1. **未配置不发起请求**（`AI_NOT_CONFIGURED` 是预期分支，面板据此渲染引导）。
 * 2. **失败不抛**：一律 `AiResult`，错误码已脱敏。
 * 3. **apiKey 只在发往 main 的请求体里出现**；本对象不写日志、不进错误载荷。
 *
 * ⚠️ 模型配置**按作品存**（与旧版一致：旧版 settings 键就是 `${projectId}::${key}`），
 *    因此保存前必须有当前作品；`projectId()` 返回 null 时保存会失败，
 *    面板要先引导用户建作品。
 */

import type { IdempotencyKey, ProjectId, RequestId, Revision, WorkspaceId } from '@yfe/contracts'

import type { RendererClientPort } from '../app-state.js'
import {
  AI_CONFIG_NAME,
  AI_CONFIG_TEMPLATE_ID,
  isAiConfigured,
  normalizeAiModelConfig,
} from './config.js'
import type { AiErrorCode, AiModelConfig, AiPort, AiRequest, AiResult } from './types.js'

/** 主进程/客户端返回的错误码 → 面板层的 AI 错误码。 */
function aiCodeFrom(code: string): AiErrorCode {
  if (code.startsWith('AI_')) return code as AiErrorCode
  if (code === 'NETWORK_TIMEOUT') return 'AI_TIMEOUT'
  return 'AI_UPSTREAM_ERROR'
}

export interface AiPortOptions {
  readonly newRequestId: () => RequestId
  readonly workspaceId: WorkspaceId
  /** 当前作品（模型配置按作品存）；null = 尚无作品。 */
  readonly projectId: () => ProjectId | null
}

export function createAiPort(client: RendererClientPort, options: AiPortOptions): AiPort {
  let config: AiModelConfig | null = null
  let entityId: string | null = null
  let revision: string | null = null
  let saveSequence = 0

  async function reload(): Promise<boolean> {
    const result = await client.listSettingsEntities({
      context: { requestId: options.newRequestId(), workspaceId: options.workspaceId },
      schemaTemplateId: AI_CONFIG_TEMPLATE_ID,
    })
    if (!result.ok) {
      config = null
      return false
    }
    const rows = result.value.entities
    const first = rows.find((row) => row.schemaTemplateId === AI_CONFIG_TEMPLATE_ID && !row.deleted)
    if (first === undefined) {
      entityId = null
      revision = null
      config = null
      return false
    }
    entityId = first.id
    revision = first.revision
    config = normalizeAiModelConfig(first.values)
    return true
  }

  async function saveConfig(next: AiModelConfig): Promise<boolean> {
    const sequence = ++saveSequence
    const currentProjectId = options.projectId()
    if (currentProjectId === null) return false // 没有作品：面板要先引导建作品
    const result = await client.saveSettingsEntity({
      context: {
        requestId: options.newRequestId(),
        workspaceId: options.workspaceId,
        projectId: currentProjectId,
        expectedRevision: entityId === null ? null : (revision as Revision),
        idempotencyKey: `ai-config:${sequence}` as IdempotencyKey,
      },
      entityId,
      projectId: currentProjectId,
      schemaTemplateId: AI_CONFIG_TEMPLATE_ID,
      name: AI_CONFIG_NAME,
      // `values` 整体替换（R-66）：必须回传完整字段集，缺字段会被归一化成默认值。
      values: { ...next },
    })
    if (!result.ok) return false
    if (sequence !== saveSequence) return false // 迟到结果：丢弃
    entityId = result.value.entityId
    revision = result.value.revision
    config = normalizeAiModelConfig({ ...next })
    return true
  }

  async function complete(request: AiRequest): Promise<AiResult> {
    if (!isAiConfigured(config)) {
      return {
        ok: false,
        code: 'AI_NOT_CONFIGURED',
        message: '尚未配置可用模型：请到「模型设置」页签填写接口地址、模型名与 API Key',
      }
    }
    const current = config
    if (current === null) {
      return { ok: false, code: 'AI_NOT_CONFIGURED', message: '尚未配置可用模型' }
    }
    const result = await client.aiComplete({
      config: {
        baseUrl: current.baseUrl,
        apiKey: current.apiKey,
        model: current.model,
        temperature: request.temperature ?? current.temperature,
        maxTokens: request.maxTokens ?? current.maxTokens,
        timeoutMs: current.timeoutMs,
      },
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: request.messages,
    })
    if (!result.ok) {
      return { ok: false, code: aiCodeFrom(result.error.code), message: result.error.message }
    }
    const value = result.value
    return {
      ok: true,
      text: value.text,
      ...(value.usage === undefined ? {} : { usage: value.usage }),
      ...(value.model === undefined ? {} : { model: value.model }),
    }
  }

  return {
    getConfig: () => config,
    configured: () => isAiConfigured(config),
    reload,
    saveConfig,
    complete,
  }
}
