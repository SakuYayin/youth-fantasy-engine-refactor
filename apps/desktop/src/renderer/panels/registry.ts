/**
 * 面板注册表：`TabDef.id` → 面板组件。
 *
 * 唯一的登记处（Lead 独占）。面板智能体**不要**改这个文件：交付后由 Lead 把组件挂上来，
 * 这样 21 个面板并行开发时不会互相冲突。
 *
 * 未登记的 id 由 `resolvePanelComponent` 回落到占位组件（明确写「尚未接入」）。
 */

import type { Component } from 'vue'

import About from './about.vue'
import BookBreak from './bookbreak.vue'
import Dashboard from './dashboard.vue'
import GeographyMap from './geography-map.vue'
import Placeholder from './_placeholder.vue'
import CheckTools from './check-tools.vue'
import CreativeWriting from './creative-writing.vue'
import Guide from './guide.vue'
import InspireTools from './inspire-tools.vue'
import MaterialLibrary from './material-library.vue'
import ModelSettings from './model-settings.vue'
import PlotCanvas from './plot-canvas.vue'
import Trajectory from './trajectory.vue'
import TavernCard from './tavern-card.vue'
import TavernPlot from './tavern-plot.vue'
import TavernRun from './tavern-run.vue'
import TavernScript from './tavern-script.vue'
import TavernWorld from './tavern-world.vue'
import TavernFree from './tavern-free.vue'
import TavernReport from './tavern-report.vue'
import TavernControl from './tavern-control.vue'
import Worlds from './worlds.vue'
import type { PanelProps } from './types.js'

export type PanelComponent = Component<PanelProps>

/** 已接入的面板。键 = `TabDef.id`。 */
export const PANEL_COMPONENTS: Readonly<Record<string, PanelComponent>> = {
  // W7 波次登记处：每落地一个面板由 Lead 在此加一行（静态 import，便于构建期发现错误）。
  about: About,
  bookbreak: BookBreak,
  'check-tools': CheckTools,
  'creative-writing': CreativeWriting,
  dashboard: Dashboard,
  'geography-map': GeographyMap,
  guide: Guide,
  'inspire-tools': InspireTools,
  'material-library': MaterialLibrary,
  'model-settings': ModelSettings,
  // 🔴 键必须逐字等于 `TabDef.id`。曾误写成 `plotCanvas`（驼峰），而权威 id 是
  // `plot-canvas`（packages/schema-tabs/src/schemaTabs/part2.ts 的 `id: 'plot-canvas'`）
  // ⇒ 该面板永远匹配不上、静默回落占位。已由 `tests/panel-registry.test.ts` 钉死。
  'plot-canvas': PlotCanvas,
  trajectory: Trajectory,
  'tavern-card': TavernCard,
  'tavern-plot': TavernPlot,
  'tavern-run': TavernRun,
  'tavern-script': TavernScript,
  'tavern-world': TavernWorld,
  'tavern-free': TavernFree,
  'tavern-report': TavernReport,
  'tavern-control': TavernControl,
  worlds: Worlds,
  // 🔴 整表断言的原因：`tsconfig.tests.json` 是纯 tsc，`.vue` 走 `vue-shims.d.ts` 的
  // 宽松声明（props 是 `Record<string, unknown>`），拿它当 `Component<PanelProps>`
  // 逐项赋值必然 TS2322；而 vue-tsc 那侧读的是真实 SFC props，本文件在那边本来就通过。
  // 键与真实页签 id 的一致性（含「不多不少」）由 `tests/panel-registry.test.ts` 钉死。
} as Readonly<Record<string, PanelComponent>>

export function resolvePanelComponent(tabId: string): PanelComponent {
  return PANEL_COMPONENTS[tabId] ?? (Placeholder as PanelComponent)
}

/** 已接入的面板 id（测试与真窗口验收用）。 */
export function registeredPanelIds(): readonly string[] {
  return Object.keys(PANEL_COMPONENTS).sort()
}
