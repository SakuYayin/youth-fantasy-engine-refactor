/**
 * 「关于打赏」面板（`tab.id = 'about'`）的文案常量与纯逻辑。
 *
 * 接口冻结 §2：组件内不写死大段静态文案——所有可见文案都收敛到这里导出，
 * 便于测试做「可见文本 ⊆ 页签文案 ∪ 常量」的审计与后续替换。
 *
 * 本面板没有持久化数据（纯静态展示 + 一次复制动作），因此不接 `panel-store`
 * （§3 只约束「面板自己的数据」）；版本号读 `state.getSnapshot().appVersion`，
 * 也不需要 AI 能力。
 */

// ==================== 标题与简介 ====================

/** 应用名（与上游 AboutPage.tsx 一致）。 */
export const APP_NAME = '青春幻想引擎'
/** 应用英文名。 */
export const APP_NAME_EN = 'Youth Fantasy Engine'
/** 「应用信息」区块标题。 */
export const APP_SECTION_TITLE = '应用信息'
/** 项目一句话简介。 */
export const APP_INTRO = '在你的世界中讲述你的故事——面向网文作者的本地写作工具。'

// ==================== 版本号 ====================

/** 版本号缺失 / 为空时的回退显示（显式说明，不静默空白）。 */
export const VERSION_FALLBACK = '开发版'
/** 版本行前缀标签。 */
export const VERSION_LABEL = '当前版本'

/**
 * 版本显示的回退规则：`null` 或去首尾空白后为空 → 「开发版」，否则原样显示。
 *
 * 纯函数（不摸 `state`）：面板渲染与单测共用同一份规则，避免两处各写一套导致不同步。
 */
export function displayVersion(appVersion: string | null): string {
  const trimmed = appVersion?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : VERSION_FALLBACK
}

// ==================== 重构说明 ====================

/** 「重构说明」区块标题。 */
export const REBUILD_TITLE = '重构说明'

/**
 * 新架构与预览版范围说明（逐条渲染）。
 *
 * 内容契约：必须覆盖「本地 SQLite」「Vue 3」「预览版范围」三件事
 * （单测 `about.test.ts` 按关键词断言，改文案时同步改断言）。
 */
export const REBUILD_NOTES: readonly string[] = [
  '新架构：数据全部保存在本地 SQLite 数据库，不经任何云端服务，离线可用。',
  '界面基于 Vue 3 重写，功能按旧版逐页迁移；未完成的面板会显式标注，不会静默空白。',
  '预览版范围说明：作品 / 章节 / 正文编辑等核心写作流程已可用，酒馆模式与 AI 流水线等面板仍在按批次接入。',
]

// ==================== 打赏 / 支持 ====================

/** 「打赏支持」区块标题。 */
export const SUPPORT_TITLE = '打赏支持'
/** 打赏区块说明（静态文案；预览版没有收款码图片，以内置链接代替）。 */
export const SUPPORT_DESC =
  '如果本软件对你有帮助，欢迎支持作者。你的支持是持续更新与维护项目的最大动力！'
/** 支持链接（静态内置，指向作者的 B 站主页；预览版不做任何联网检查）。 */
export const SUPPORT_LINK = 'https://b23.tv/zl4vqyw'
/** 链接说明。 */
export const SUPPORT_LINK_NOTE =
  '链接指向作者的 B 站主页，关注作者即可获取更新公告与使用教程。'

/** 「复制支持链接」按钮标签。 */
export const COPY_BUTTON_LABEL = '复制支持链接'
/** 复制成功提示。 */
export const COPY_SUCCESS = '已复制支持链接，可粘贴分享。'
/** 复制失败提示（复制失败 = 请手动选择复制）。 */
export const COPY_FAILURE = '复制失败，请手动选择复制上方链接'
/** 剪贴板不可用时的前置提示（按钮不禁用：点击仍会尝试并给出失败提示）。 */
export const CLIPBOARD_HINT = '当前环境剪贴板不可用，无法自动复制；请手动选择复制上方链接。'

// ==================== 剪贴板可用性 ====================

/**
 * 剪贴板是否可用：只认「有 `writeText` 函数」。
 *
 * 纯函数（入参 `unknown`，不摸 `navigator` 全局）：面板渲染与单测共用同一份判定，
 * 避免面板里散落 `typeof navigator` 判断导致行为不一致。
 */
export function canUseClipboard(clipboard: unknown): boolean {
  if (typeof clipboard !== 'object' || clipboard === null) return false
  if (!('writeText' in clipboard)) return false
  return typeof clipboard.writeText === 'function'
}
