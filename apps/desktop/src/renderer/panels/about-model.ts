/**
 * 「关于打赏」面板（`tab.id = 'about'`）的纯逻辑与文案常量（W9-3 · C-02）。
 *
 * 上游依据（只读参考）：
 * - `_upstream_tmp/youth-fantasy-engine-main/src/components/app/AboutPage.tsx`（329 行）
 * - `.../src/components/app/UpdateDialog.tsx`（更新弹窗文案与四态）
 * - `.../src/lib/app/versionCheck.ts`（`checkUpdate` 的四态判定口径）
 * - `.../src/lib/app/downloadLinks.ts`（夸克网盘 URL / 提取码 / APP 口令）
 * - `.../src/lib/app/env.ts`（`APP_VERSION_LABEL`：正式版带 `v` 前缀，回退态为「开发版」）
 * - `.../src/lib/storage/legacyMigration.ts`（`probeLegacy` 的「失败 / 没找到 / 没有可导入数据」三段判定）
 * - `.../src/lib/app/diagnostics.ts`（复制诊断信息的三条红线：不含作品内容 / 密钥 / 路径）
 *
 * 🔴 分层口径：本文件**不联网、不碰 DOM、不 import `node:`**。上游会自己联网 / 读文件 /
 * 读写 localStorage 的动作，在本仓一律改成「状态经 props 传入 + 动作经 emit 请求」：
 * - 版本 / 构建时间：`appVersion` / `buildAt` props（缺省回退 `state.getSnapshot().appVersion`）；
 * - 更新检查：`update` / `checking` / `checkError` / `autoCheck` props；
 *   请求经 `check-update` / `set-auto-check` 事件发出（渲染层 CSP `connect-src 'none'` 本就不能联网）；
 * - 打开链接（B 站主页 / 网盘 / 安装包直链）：`open-link` 事件，组件不自己 `window.open`；
 * - 旧版数据探测：`legacyProbe` prop（结构 = 上游 `LegacyProbe` 的子集）+ `import-legacy-data` 事件；
 * - 诊断信息：`diagnostics` prop（正文由外壳采集）+ `collect-diagnostics` 事件；
 * - 收款码 / 头像图片：`authorAvatarUrl` / `wechatPayUrl` / `alipayPayUrl` props（缺省渲染占位说明）。
 *
 * 文案逐字对齐上游；图片与联网能力缺失处**显式说明**（不许静默空白）。
 */

/* ==================== 上游逐字常量 ==================== */

/** 上游 `AboutPage.tsx:21`（B 站主页短链，与上游逐字一致）。 */
export const BILI_URL = 'https://b23.tv/zl4vqyw'
/** 上游 `AboutPage.tsx:22`。 */
export const BILI_NAME = '铁骨咸鱼'
/** 上游 `AboutPage.tsx:126`（作者名）。 */
export const AUTHOR_NAME = '铁骨咸鱼'
/** 上游 `AboutPage.tsx:128`。 */
export const AUTHOR_DESC =
  '在你的世界中讲述你的故事（B站主页有软件使用的视频教程，欢迎加群交流分享或反馈Bug）'
/** 上游 `AboutPage.tsx:136`（`{BILI_NAME} 的 B 站主页`）。 */
export const BILI_BUTTON_LABEL = `${BILI_NAME} 的 B 站主页`

/**
 * 致谢名单（上游 `AboutPage.tsx:25-30`）。
 * 上游注释：按打赏时间排序、由作者手工维护，新打赏者追加到数组末尾，数组顺序＝展示顺序。
 */
export const THANKS: readonly string[] = ['神秘鱼先生', 'Ryan', '神秘佑先生', '相念']

/** 联系方式条目（上游 `AboutPage.tsx:33-37`，逐字）。 */
export interface ContactLink {
  readonly label: string
  readonly value: string
}

/**
 * 上游注释：导出供本地数据提醒弹窗复用，避免两处各写一份导致不同步。
 * 本面板只渲染，不导出给别处（跨面板共享常量归 Lead）。
 */
export const CONTACT_LINKS: readonly ContactLink[] = [
  { label: '青春幻想引擎交流群', value: '1106815480' },
  { label: '作者 QQ', value: '1822304733' },
  { label: '公众号', value: '咸鱼哥的双线人生' },
]

/** 上游 `lib/app/downloadLinks.ts`：夸克网盘分享地址（props 未接线时的内置回退）。 */
export const QUARK_URL = 'https://pan.quark.cn/s/8ae0eb718cf5?pwd=QfAm'
/** 上游 `lib/app/downloadLinks.ts`：提取码。 */
export const QUARK_CODE = 'QfAm'
/** 上游 `lib/app/downloadLinks.ts`：夸克 APP 口令（含换行，复制整段后由夸克 APP 识别）。 */
export const QUARK_TOKEN =
  '我用夸克网盘给你分享了「青春幻想引擎」，点击链接或复制整段内容，打开「夸克APP」即可获取。\n/~bb863abBGY~:/'
/** 上游 `lib/app/downloadLinks.ts`：Gitee Release 页（直链打不开时的兜底）。 */
export const GITEE_RELEASES_URL = 'https://gitee.com/tgxy2026/youth-fantasy-engine/releases'

/* ==================== 页面骨架文案（上游 `AboutPage.tsx:98-110`） =================== */

/** 上游 `AboutPage.tsx:101`（页签 `about` 的 `name` 也是这四个字，面板标题用 `props.tab.name`）。 */
export const PAGE_TITLE = '关于打赏'
/** 上游 `AboutPage.tsx:102`（帮助气泡标题）。 */
export const HELP_TITLE = '这一页是什么'
/** 上游 `AboutPage.tsx:104`（便携版文案）。 */
export const HELP_TEXT_PORTABLE =
  '介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 致谢名单按打赏时间排序，随打赏持续更新；\n· 页面图文与链接均为内置静态资源；便携版不做任何联网检查。'
/** 上游 `AboutPage.tsx:105`（常规版文案）。 */
export const HELP_TEXT_NORMAL =
  '介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 致谢名单按打赏时间排序，随打赏持续更新；\n· 页面图文与链接均为内置静态资源；会联网的只有版本检查 —— 手动点「检查更新」，以及默认开启的「启动时自动检查」（可在本页关掉）。'
/** 上游 `AboutPage.tsx:109`（副标题，含英文名 `Youth Fantasy Engine`）。 */
export const PAGE_INTRO_APP = '关于「青春幻想引擎」（'
export const APP_NAME_EN = 'Youth Fantasy Engine'
export const PAGE_INTRO_TAIL = '）与它的作者，以及支持作者的方式。'

/* ==================== 区块标题（上游 `SectionTitle`） ==================== */

export const SECTION_AUTHOR = '作者信息'
export const SECTION_DOWNLOAD = '获取最新版本'
export const SECTION_MIGRATION = '旧版数据迁移'
export const SECTION_CONTACT = '联系方式'
export const SECTION_SUPPORT = '打赏支持'
export const SECTION_THANKS = '致谢名单'

/* ==================== 「获取最新版本」块（上游 `:141-232`） ==================== */

/** 上游 `:146-148`：`当前版本 {APP_VERSION_LABEL}。新版本安装包发布在...`。 */
export const VERSION_LABEL = '当前版本'
export const VERSION_FALLBACK = '开发版'
export const DOWNLOAD_DESC_PREFIX = '当前版本 '
export const DOWNLOAD_DESC_SUFFIX =
  '。新版本安装包发布在下方网盘，更新公告同步发在 B 站主页、公众号与 QQ 交流群——若社交平台看到更新公告，可来此获取最新版。'
/** 上游 `:152-153`（旧版按机器安装需先管理员升级一次）。 */
export const INSTALL_TIP_LABEL = '安装提示：'
export const INSTALL_TIP_TEXT =
  '若你电脑上已安装过旧版（装在 C 盘「Program Files」目录下），请先用「右键 → 以管理员身份运行」打开本安装包完成一次升级；升级后会迁移为「当前用户安装」，之后重装都不再需要管理员权限。'
/** 上游 `:161-162`（便携版分支：不提供在线更新）。 */
export const PORTABLE_DOWNLOAD_NOTE =
  '便携版不提供在线更新：有新版本时请到发布页下载新的便携版压缩包，解压后把旧目录里的 data 文件夹拷进新目录即可 —— 稿件不会丢。'
/** 上游 `:168` / `:166`。 */
export const CHECK_LABEL = '检查更新'
export const CHECKING_LABEL = '检查中…'
/** 上游 `:177`。 */
export const AUTO_CHECK_LABEL = '启动时自动检查'
/** 上游 `:203` / `:210` / `:215` / `:225`（下载入口排）。 */
export const OPEN_QUARK_LABEL = '打开网盘下载'
export const COPY_TOKEN_LABEL = '复制 APP 口令'
export const QUARK_CODE_LABEL = '提取码'
export const COPY_LABEL = '复制'
/** 上游 `:229`。 */
export const QUARK_INVALID_NOTE =
  '若链接失效或提取码有误，请加 QQ 交流群 或关注公众号获取最新地址。'
/** 上游 `:163`（便携版分支的「下载页」按钮文案）。 */
export const PORTABLE_RELEASE_LABEL = '前往发布页下载'
/** 本仓补充：构建时间只在外壳经 props 传入时展示（上游不展示构建时间）。 */
export const BUILD_AT_LABEL = '构建时间：'
/** 上游 `dialogs.copyText` 的提示语（`:207`）。 */
export const COPY_TOKEN_SUCCESS = '已复制 APP 口令，打开夸克 APP 即可识别'
/** 上游 `:222`。 */
export const COPY_CODE_SUCCESS = '提取码已复制'
/** 上游 `:264`（`:143` 的区块标题已在上方）。 */
export const DIAG_COPY_SUCCESS = '诊断信息已复制，粘贴给作者即可'

/* ==================== 检查更新的四态文案（上游 `:179-189`） ==================== */

/** 上游 `:182`：`有新版本 v${latest.version}`。 */
export const UPDATE_HAS_NEW_PREFIX = '有新版本 '
/** 上游 `:186`：`已是最新版本`。 */
export const UPDATE_LATEST = '已是最新版本'
/** 上游 `:187`：`暂时查不到版本信息`。 */
export const UPDATE_UNKNOWN = '暂时查不到版本信息'
/** 上游 `:184`：`已跳过 v${version}（有新版本，但你选过跳过）`。 */
export function skippedLabel(version: string): string {
  return `已跳过 v${version}（有新版本，但你选过跳过）`
}
/** 版本串缺失时的兜底（上游直接拼 `v${latest?.version}`，会打出 `vundefined`，这里不照抄该缺陷）。 */
export const VERSION_UNKNOWN = '未知'

/* ==================== 检查更新（props 传入的结果 / 失败提示） ==================== */

/**
 * 更新检查结果（由外壳经 props 传入；面板**不联网**）。
 * 字段口径对齐上游 `LatestRelease` + `CheckResult`：
 * - `available`：严格大于当前版本（上游 `hasUpdate`）；
 * - `skipped`：该版本被作者点过「跳过此版本」（上游 `skipped`）；
 * - `latestFound`：这一次查到了 Release —— 用来区分「已是最新版本」与「暂时查不到版本信息」
 *   （上游靠 `result.latest` 是否为 null 区分）。
 */
export interface AboutUpdateInfo {
  readonly available: boolean
  readonly skipped?: boolean
  readonly version?: string
  readonly notes?: string
  readonly downloadUrl?: string
  readonly releaseUrl?: string
  readonly latestFound?: boolean
  readonly current?: string | null
}

/** 上游 `versionCheck.checkUpdate` 只比版本号：可用版本串缺失时用「未知」占位，不输出 `vundefined`。 */
export function updateVersionText(version: string | undefined): string {
  const text = (version ?? '').trim()
  return text === '' ? VERSION_UNKNOWN : text
}

/**
 * 四态结果文案（上游 `:179-189`）；尚无结果（`update == null`）时返回 `null`（上游 `{result && ...}`）。
 * 判定顺序与上游逐字一致：有更新 → 已跳过 → 已是最新 → 查不到。
 */
export function describeUpdateResult(update: AboutUpdateInfo | null | undefined): string | null {
  if (update == null) return null
  if (update.available) return `${UPDATE_HAS_NEW_PREFIX}v${updateVersionText(update.version)}`
  if (update.skipped === true) return skippedLabel(updateVersionText(update.version))
  const latestFound = update.latestFound ?? update.version !== undefined
  return latestFound ? UPDATE_LATEST : UPDATE_UNKNOWN
}

/** 上游自动检查失败一律静默；手动检查这条路允许回一句轻提示 —— 本项目要求失败必须可见。 */
export const CHECK_ERROR_PREFIX = '检查更新失败：'

/** `checkError` 非空时的可见文案。 */
export function describeCheckError(error: string | null | undefined): string | null {
  const text = (error ?? '').trim()
  return text === '' ? null : `${CHECK_ERROR_PREFIX}${text}`
}

/** 更新检查尚未接线（三个相关 props 全为 undefined）时的显式说明。 */
export const CHECK_UNWIRED_HINT =
  '更新检查尚未接线：本面板只发出检查请求，结果与开关状态由外壳经 props 回传。'

/* ==================== 更新弹窗（上游 `UpdateDialog.tsx`） ==================== */

/** 上游 `UpdateDialog` 标题：`发现新版本 v${latest?.version}`。 */
export function updateDialogTitle(version: string | undefined): string {
  return `发现新版本 v${updateVersionText(version)}`
}
/** 上游 `UpdateDialog` 正文首段（逐字）。 */
export const UPDATE_DIALOG_INTRO =
  '当前版本已落后，下面是更新说明。点「下载安装包」会下载到你的「下载」文件夹并打开安装向导。'
/** 上游 `UpdateDialog`：本次没取到安装包直链时的说明。 */
export const UPDATE_NO_DOWNLOAD_URL = '本次没取到安装包直链，请用下方网盘获取。'
/** 上游 `UpdateDialog`：更新说明为空时的占位（`（这个版本没有填写更新说明）`）。 */
export const UPDATE_NOTES_EMPTY = '（这个版本没有填写更新说明）'
/** 上游 `UpdateDialog` 底部按钮。 */
export const UPDATE_DOWNLOAD_LABEL = '下载安装包'
export const UPDATE_QUARK_LABEL = '夸克网盘'
export const UPDATE_CLOSE_LABEL = '稍后提醒'
export const UPDATE_SKIP_LABEL = '跳过此版本'
/** 上游 `UpdateDialog`：网盘由作者手动同步。 */
export const UPDATE_QUARK_NOTE = '网盘由作者手动同步，可能稍慢于 Gitee。'

/**
 * 更新说明切块（上游用 `mdLite.parseMarkdownBlocks` 切块后以纯文本节点渲染 —— 外部输入绝不走 innerHTML）。
 *
 * 本仓不引入 markdown 解析依赖：这里只做「按行切块 + 去掉行首 markdown 标记」，
 * 输出纯文本行；标题与正文不再区分（偏差已在交付报告登记）。空输入返回空数组。
 */
export function splitUpdateNotes(body: string | null | undefined): readonly string[] {
  const text = (body ?? '').trim()
  if (text === '') return []
  const lines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*>+\s*/, '')
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .trim()
    if (line !== '') lines.push(line)
  }
  return lines
}

/* ==================== 旧版数据迁移（上游 `:57-67` / `:234-243`） ==================== */

/** 上游 `:238`。 */
export const MIGRATION_DESC =
  '若你之前用过旧版（novel-studio），可在这里把旧版的书稿、向量索引与知识库一次性导入到本软件。'
/** 上游 `:241`。 */
export const IMPORT_LEGACY_LABEL = '导入旧版数据'
/** 上游 `probeLegacy` 结果的子集（`LegacyProbe`，`legacyMigration.ts`）。 */
export interface AboutLegacyProbe {
  readonly exists: boolean
  readonly error?: string
  readonly jsonExists?: boolean
  readonly idbExists?: boolean
}
/** 上游 `:63`。 */
export const LEGACY_PROBE_ERROR_PREFIX = '探测旧版数据失败：'
/** 上游 `:64`。 */
export const LEGACY_NOT_FOUND = '未找到旧版（novel-studio）的数据目录'
/** 上游 `:65`。 */
export const LEGACY_NO_DATA = '旧版目录存在，但没有可导入的数据'
/** 上游 `:66` 走的是弹迁移向导；向导由外壳提供，这里如实说明去向。 */
export const LEGACY_FOUND = '已找到可导入的旧版数据（迁移向导由外壳打开）'
/** 外壳完全没传探测结果时的显式说明（不许静默空白）。 */
export const LEGACY_UNWIRED_NOTE =
  '旧版数据探测由外壳执行：本面板只发出导入请求，探测结果经 props 回传（当前未接线）。'

export interface LegacyProbeMessage {
  readonly tone: 'error' | 'info'
  readonly message: string
}

/**
 * 三段探测判定（上游 `:62-66`）。
 * 🔴 上游注释写死：**先报「探测失败」再报「没找到」** —— 失败与没有是两回事。
 */
export function describeLegacyProbe(
  probe: AboutLegacyProbe | null | undefined,
): LegacyProbeMessage | null {
  if (probe == null) return null
  const error = (probe.error ?? '').trim()
  if (error !== '') return { tone: 'error', message: `${LEGACY_PROBE_ERROR_PREFIX}${error}` }
  if (!probe.exists) return { tone: 'info', message: LEGACY_NOT_FOUND }
  if (probe.jsonExists !== true && probe.idbExists !== true) {
    return { tone: 'info', message: LEGACY_NO_DATA }
  }
  return { tone: 'info', message: LEGACY_FOUND }
}

/* ==================== 联系方式 / 诊断信息（上游 `:257-267`） ==================== */

/** 上游 `:261`（按钮文案随采集态变化）。 */
export const DIAG_LABEL = '复制诊断信息'
export const DIAG_BUSY_LABEL = '采集中…'
/** 上游 `:264-265`（三条红线）。 */
export const DIAG_NOTE =
  '反馈问题时附上这段：版本、系统、数据规模与 AI 配置概况。不含任何作品内容、密钥与文件路径，可放心粘贴。'
/** 诊断信息未随 props 传入、已发出采集请求时的等待文案。 */
export const DIAG_WAITING = '已请求外壳采集诊断信息，内容回传后会自动复制…'

/* ==================== 打赏支持（上游 `:278-324`） ==================== */

/** 上游 `:281`。 */
export const SUPPORT_DESC = '如果本软件对你有帮助，欢迎扫码支持作者。'
/** 上游 `:304`（致谢小标题）与 `:307`（说明）。 */
export const THANKS_NOTE = '致谢名单按照打赏时间排序，您的支持是我持续更新和维护项目的最大动力！'
export const THANKS_EMPTY = '致谢名单暂空（名单由外壳经 props 传入）。'
/** 收款码 alt 文案（上游 `:294` `${微信|支付宝}收款码`）。 */
export const PAY_WECHAT_LABEL = '微信收款码'
export const PAY_ALIPAY_LABEL = '支付宝收款码'

/** 收款码条目。 */
export interface PayCode {
  readonly key: 'wechat' | 'alipay'
  readonly label: string
  readonly url: string
}

/* ==================== 未接线时的显式说明（不许静默空白） ==================== */

/** 收款码图片未接入时，占位块里的说明。 */
export function payPlaceholderNote(label: string): string {
  return `${label}图片由外壳提供（当前未接线），先在原位占位。`
}
/** 头像图片未接入时的占位说明。 */
export const AVATAR_PLACEHOLDER_NOTE = '头像图片由外壳提供（当前未接线）'
/** 网盘地址未接入时的说明（上游在 `QUARK_URL` 为空时整块不渲染；本项目要求显式说明）。 */
export const QUARK_UNWIRED_NOTE = '网盘下载地址由外壳提供（当前未接线）。'

/* ==================== 面板输入（全部可选；Lead 按此接线） ==================== */

/**
 * 面板的**可选**额外输入（`PanelProps` 之外）。
 *
 * 全部可选是硬要求：`registry.ts` 把面板登记为 `Component<PanelProps>`，
 * 不传这些 props 时面板必须按「未接线」如实渲染，不得白屏、不得假装成功。
 */
export interface AboutPanelInputs {
  /** 应用版本号（上游 `APP_VERSION_LABEL` 的来源）。缺省回退 `state.getSnapshot().appVersion`。 */
  readonly appVersion?: string | null
  /** 构建时间（可选展示；上游不展示，本仓为可观测性补一行）。 */
  readonly buildAt?: string | null
  /** 便携版（上游 `PORTABLE`）：便携版不做任何联网检查，更新区改为静态指引。 */
  readonly portable?: boolean
  /** 更新检查结果（外壳查询后传入）。 */
  readonly update?: AboutUpdateInfo | null
  /** 是否正在检查更新（按钮禁用 + 「检查中…」）。 */
  readonly checking?: boolean
  /** 检查失败的脱敏原因（非空即可见中文提示）。 */
  readonly checkError?: string | null
  /** 「启动时自动检查」开关的当前值（持久化在外壳）。 */
  readonly autoCheck?: boolean
  /** 旧版数据探测结果（外壳探测后传入）。 */
  readonly legacyProbe?: AboutLegacyProbe | null
  /** 诊断信息正文（外壳采集后传入；面板只负责复制）。 */
  readonly diagnostics?: string | null
  /** 作者头像图片地址。 */
  readonly authorAvatarUrl?: string | null
  /** 微信收款码图片地址。 */
  readonly wechatPayUrl?: string | null
  /** 支付宝收款码图片地址。 */
  readonly alipayPayUrl?: string | null
  /** 夸克网盘地址（缺省用内置 `QUARK_URL`）。传空串表示「未接线」。 */
  readonly quarkUrl?: string | null
  /** 提取码（缺省用内置 `QUARK_CODE`）。 */
  readonly quarkCode?: string | null
  /** 夸克 APP 口令（缺省用内置 `QUARK_TOKEN`）。 */
  readonly quarkToken?: string | null
  /** 致谢名单（缺省用内置 `THANKS`；传空数组表示「暂空」）。 */
  readonly thanks?: readonly string[]
}

/* ==================== 纯函数 ==================== */

/**
 * 版本号展示文本（上游 `lib/app/env.ts` 的 `APP_VERSION_LABEL`）：
 * 正式版 `v3.0.1`（带 `v` 前缀），dev / 未注入时为「开发版」（**不带 `v`**，避免拼出「v开发版」）。
 *
 * 与上游的唯一差别：上游对已是 `v0.2.0` 的输入会拼成 `vv0.2.0`，这里不照抄该缺陷。
 */
export function formatVersionLabel(raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  if (text === '' || text === VERSION_FALLBACK) return VERSION_FALLBACK
  return /^v/i.test(text) ? `v${text.slice(1)}` : `v${text}`
}

/** 构建时间展示：空值返回 `null`（不渲染该行）。 */
export function formatBuildAt(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  return text === '' ? null : text
}

/** 空值回退：`null` / `undefined` 回退到内置值（泛型版本，`''` 是合法值、按传入值处理）。 */
export function withFallback<T>(value: T | null | undefined, fallback: T): T {
  return value == null ? fallback : value
}

/**
 * 字符串型回退：null / undefined / 空串与纯空白一律取 `fallback`。
 * 只用于**静态文案**（口令、提取码）；链接类的「外壳显式传空串 = 本次没有」不走这里，
 * 由 `about.vue` 的 `quarkUrl` 计算属性单独处理（空值保留为空，不回落内置短链）。
 */
export function withStringFallback(value: string | null | undefined, fallback: string): string {
  const text = (value ?? '').trim()
  return text === '' ? fallback : text
}

/** 剪贴板最小面（只关心 `writeText`，便于单测注入）。 */
export interface ClipboardLike {
  readonly writeText?: (text: string) => Promise<void>
}

/** 剪贴板能力判定（上游 `copyText` 会先看 `navigator.clipboard`）。 */
export function canUseClipboard(clipboard: unknown): boolean {
  if (clipboard === null || typeof clipboard !== 'object') return false
  const writeText = (clipboard as { writeText?: unknown }).writeText
  return typeof writeText === 'function'
}

/** 复制失败时的统一提示（剪贴板缺失 / 权限拒绝 / 其它异常都归到这一句）。 */
export const COPY_FAILURE = '复制失败：剪贴板不可用，请手动选择复制'
/** 剪贴板不可用时的前置提示（按钮**不禁用**：点击仍会尝试并给出失败提示）。 */
export const CLIPBOARD_HINT = '当前环境拿不到剪贴板：点击复制会失败，请手动选择文本复制。'
/** 更新提示块的区域内名称（`role="region"` 的无障碍名，非可见文案）。 */
export const UPDATE_DIALOG_ARIA = '发现新版本'

/** 复制文本：成功 `true`；剪贴板缺失或 `writeText` 抛错都 `false`（绝不抛出）。 */
export async function copyText(clipboard: unknown, text: string): Promise<boolean> {
  if (!canUseClipboard(clipboard)) return false
  try {
    await (clipboard as Required<ClipboardLike>).writeText(text)
    return true
  } catch {
    return false
  }
}