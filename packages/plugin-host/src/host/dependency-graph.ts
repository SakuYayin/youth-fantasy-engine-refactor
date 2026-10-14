/**
 * 依赖图解析（纯函数，无 IO、无 cordis 依赖）。
 *
 * 🔴 为什么宿主必须自己做：实测（ADR 0002 结论 4）`ctx.plugin()` 对**依赖未满足**的插件
 * 同样 `await` 成功 resolve，Cordis 的 inject 只会把插件静默留在 PENDING。若把依赖判定
 * 外包给上游，「缺依赖」就会退化成「加载成功但什么都不做」——不可观测的坏状态。
 * 因此宿主在加载前独立解析依赖图，缺依赖/循环/版本不符一律**拒绝加载**。
 *
 * 设计依据：`05-插件内核与SDK.md`「生命周期：安装校验 → 解析依赖图 → 检查授权 →
 * ……；缺失依赖、循环、API 不兼容均拒绝激活」。
 */

import type { PluginManifest } from '@yfe/plugin-sdk'
import { satisfiesRange } from '@yfe/plugin-sdk'

export type GraphFailure =
  | { readonly kind: 'missing'; readonly pluginId: string; readonly missingId: string }
  | { readonly kind: 'cycle'; readonly pluginId: string; readonly cycle: readonly string[] }
  | {
      readonly kind: 'version-mismatch'
      readonly pluginId: string
      readonly dependencyId: string
      readonly required: string
      readonly found: string
    }

export type GraphResolution =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly failure: GraphFailure }

/**
 * 计算拓扑加载顺序。
 *
 * 规则：
 * - 依赖必须先于依赖者出现（深度优先后序）。
 * - 结果**确定性**：同层按 id 升序，保证同样的输入永远得到同样的加载顺序（测试可复现）。
 * - `requested` 是本次想加载的插件集合；它们依赖的插件若已在 `available` 中会被自动带上，
 *   若不在则报 `missing`（宿主不提供隐式全局注册表）。
 */
export function resolveLoadOrder(
  requested: readonly string[],
  available: ReadonlyMap<string, PluginManifest>,
): GraphResolution {
  const order: string[] = []
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const stack: string[] = []

  // 确定性：按 id 排序后再遍历。
  const roots = [...new Set(requested)].sort()

  const visit = (pluginId: string): GraphFailure | null => {
    if (visited.has(pluginId)) return null
    if (onStack.has(pluginId)) {
      const start = stack.indexOf(pluginId)
      const cycle = [...stack.slice(start), pluginId]
      return { kind: 'cycle', pluginId, cycle }
    }
    const manifest = available.get(pluginId)
    if (!manifest) {
      // 调用方负责把「根插件不存在」翻译成 PLUGIN_NOT_FOUND；这里的 missing 指依赖。
      return { kind: 'missing', pluginId: stack.length === 0 ? pluginId : (stack[stack.length - 1] ?? pluginId), missingId: pluginId }
    }
    onStack.add(pluginId)
    stack.push(pluginId)
    const dependencies = [...manifest.dependencies].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    for (const dependency of dependencies) {
      const found = available.get(dependency.id)
      if (!found) {
        onStack.delete(pluginId)
        stack.pop()
        return { kind: 'missing', pluginId, missingId: dependency.id }
      }
      if (!satisfiesRange(found.version, dependency.range)) {
        onStack.delete(pluginId)
        stack.pop()
        return {
          kind: 'version-mismatch',
          pluginId,
          dependencyId: dependency.id,
          required: dependency.range,
          found: found.version,
        }
      }
      const failure = visit(dependency.id)
      if (failure) {
        onStack.delete(pluginId)
        stack.pop()
        return failure
      }
    }
    stack.pop()
    onStack.delete(pluginId)
    visited.add(pluginId)
    order.push(pluginId)
    return null
  }

  for (const root of roots) {
    const failure = visit(root)
    if (failure) return { ok: false, failure }
  }
  return { ok: true, order }
}

/** 计算某个插件的直接依赖者（宿主在禁用插件时用于检查「谁在依赖我」）。 */
export function dependentsOf(
  pluginId: string,
  available: ReadonlyMap<string, PluginManifest>,
): readonly string[] {
  const dependents: string[] = []
  for (const [id, manifest] of available) {
    if (manifest.dependencies.some((dependency) => dependency.id === pluginId)) dependents.push(id)
  }
  return dependents.sort()
}
