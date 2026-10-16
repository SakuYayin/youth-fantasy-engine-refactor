/**
 * 「关于打赏」面板（W9-3 · C-02）**纯逻辑**测试：`about-model.ts` 的常量、判定函数与剪贴板封装。
 *
 * 不 mount 组件（视图行为在 about.view.test.ts），不摸 DOM / `state` / `navigator`：
 * 剪贴板用最小面桩（`{ writeText }`）走参数注入，不需要任何全局对象。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  APP_NAME_EN,
  AUTHOR_DESC,
  AUTHOR_NAME,
  AUTO_CHECK_LABEL,
  AVATAR_PLACEHOLDER_NOTE,
  BILI_BUTTON_LABEL,
  BILI_NAME,
  BILI_URL,
  CHECK_ERROR_PREFIX,
  CHECK_LABEL,
  CHECK_UNWIRED_HINT,
  CLIPBOARD_HINT,
  CONTACT_LINKS,
  COPY_CODE_SUCCESS,
  COPY_FAILURE,
  COPY_TOKEN_SUCCESS,
  DIAG_COPY_SUCCESS,
  DIAG_LABEL,
  DIAG_NOTE,
  DIAG_WAITING,
  DOWNLOAD_DESC_SUFFIX,
  GITEE_RELEASES_URL,
  HELP_TEXT_NORMAL,
  HELP_TEXT_PORTABLE,
  HELP_TITLE,
  INSTALL_TIP_LABEL,
  INSTALL_TIP_TEXT,
  LEGACY_FOUND,
  LEGACY_NOT_FOUND,
  LEGACY_NO_DATA,
  LEGACY_PROBE_ERROR_PREFIX,
  LEGACY_UNWIRED_NOTE,
  MIGRATION_DESC,
  OPEN_QUARK_LABEL,
  PAGE_INTRO_APP,
  PAGE_INTRO_TAIL,
  PORTABLE_DOWNLOAD_NOTE,
  QUARK_CODE,
  QUARK_INVALID_NOTE,
  QUARK_TOKEN,
  QUARK_URL,
  QUARK_UNWIRED_NOTE,
  SECTION_AUTHOR,
  SECTION_CONTACT,
  SECTION_DOWNLOAD,
  SECTION_MIGRATION,
  SECTION_SUPPORT,
  SECTION_THANKS,
  SUPPORT_DESC,
  THANKS,
  THANKS_EMPTY,
  THANKS_NOTE,
  UPDATE_CLOSE_LABEL,
  UPDATE_DIALOG_INTRO,
  UPDATE_DOWNLOAD_LABEL,
  UPDATE_HAS_NEW_PREFIX,
  UPDATE_LATEST,
  UPDATE_NO_DOWNLOAD_URL,
  UPDATE_NOTES_EMPTY,
  UPDATE_QUARK_NOTE,
  UPDATE_SKIP_LABEL,
  UPDATE_UNKNOWN,
  VERSION_FALLBACK,
  VERSION_UNKNOWN,
  canUseClipboard,
  copyText,
  describeCheckError,
  describeLegacyProbe,
  describeUpdateResult,
  formatBuildAt,
  formatVersionLabel,
  payPlaceholderNote,
  skippedLabel,
  splitUpdateNotes,
  updateDialogTitle,
  updateVersionText,
  withFallback,
  withStringFallback,
} from '../../src/renderer/panels/about-model.js'

// ==================== 上游逐字常量 ====================

describe('about-model · 上游逐字常量', () => {
  it('B 站与作者信息逐字对齐上游 AboutPage.tsx', () => {
    expect(BILI_URL).toBe('https://b23.tv/zl4vqyw')
    expect(BILI_NAME).toBe('铁骨咸鱼')
    expect(AUTHOR_NAME).toBe('铁骨咸鱼')
    expect(BILI_BUTTON_LABEL).toBe('铁骨咸鱼 的 B 站主页')
    expect(AUTHOR_DESC).toBe(
      '在你的世界中讲述你的故事（B站主页有软件使用的视频教程，欢迎加群交流分享或反馈Bug）',
    )
  })

  it('致谢名单按打赏时间排序，四条且顺序固定', () => {
    expect([...THANKS]).toEqual(['神秘鱼先生', 'Ryan', '神秘佑先生', '相念'])
  })

  it('联系方式三条逐字对齐', () => {
    expect(CONTACT_LINKS.map((link) => `${link.label}=${link.value}`)).toEqual([
      '青春幻想引擎交流群=1106815480',
      '作者 QQ=1822304733',
      '公众号=咸鱼哥的双线人生',
    ])
  })

  it('夸克网盘常量逐字对齐 downloadLinks.ts（口令含换行）', () => {
    expect(QUARK_URL).toBe('https://pan.quark.cn/s/8ae0eb718cf5?pwd=QfAm')
    expect(QUARK_CODE).toBe('QfAm')
    expect(QUARK_TOKEN).toContain('我用夸克网盘给你分享了「青春幻想引擎」')
    expect(QUARK_TOKEN).toContain('\n/~bb863abBGY~:/')
    expect(GITEE_RELEASES_URL).toBe(
      'https://gitee.com/tgxy2026/youth-fantasy-engine/releases',
    )
  })

  it('页面骨架文案逐字对齐（标题 / 帮助气泡两种文案 / 副标题）', () => {
    expect(HELP_TITLE).toBe('这一页是什么')
    expect(HELP_TEXT_NORMAL).not.toBe(HELP_TEXT_PORTABLE)
    expect(HELP_TEXT_PORTABLE).toContain('便携版不做任何联网检查')
    expect(HELP_TEXT_NORMAL).toContain('会联网的只有版本检查')
    expect(PAGE_INTRO_APP).toBe('关于「青春幻想引擎」（')
    expect(APP_NAME_EN).toBe('Youth Fantasy Engine')
    expect(PAGE_INTRO_TAIL).toBe('）与它的作者，以及支持作者的方式。')
  })

  it('区块标题与打赏块文案逐字对齐', () => {
    expect([SECTION_AUTHOR, SECTION_DOWNLOAD, SECTION_MIGRATION, SECTION_CONTACT]).toEqual([
      '作者信息',
      '获取最新版本',
      '旧版数据迁移',
      '联系方式',
    ])
    expect(SECTION_SUPPORT).toBe('打赏支持')
    expect(SECTION_THANKS).toBe('致谢名单')
    expect(SUPPORT_DESC).toBe('如果本软件对你有帮助，欢迎扫码支持作者。')
    expect(THANKS_NOTE).toBe(
      '致谢名单按照打赏时间排序，您的支持是我持续更新和维护项目的最大动力！',
    )
  })

  it('更新 / 迁移 / 诊断块的文案逐字对齐', () => {
    expect(CHECK_LABEL).toBe('检查更新')
    expect(AUTO_CHECK_LABEL).toBe('启动时自动检查')
    expect(OPEN_QUARK_LABEL).toBe('打开网盘下载')
    expect(QUARK_INVALID_NOTE).toBe(
      '若链接失效或提取码有误，请加 QQ 交流群 或关注公众号获取最新地址。',
    )
    expect(INSTALL_TIP_LABEL).toBe('安装提示：')
    expect(INSTALL_TIP_TEXT).toContain('以管理员身份运行')
    expect(DOWNLOAD_DESC_SUFFIX).toContain('更新公告同步发在 B 站主页、公众号与 QQ 交流群')
    expect(PORTABLE_DOWNLOAD_NOTE).toContain('便携版不提供在线更新')
    expect(MIGRATION_DESC).toBe(
      '若你之前用过旧版（novel-studio），可在这里把旧版的书稿、向量索引与知识库一次性导入到本软件。',
    )
    expect(DIAG_LABEL).toBe('复制诊断信息')
    expect(DIAG_NOTE).toContain('不含任何作品内容、密钥与文件路径')
    expect(COPY_TOKEN_SUCCESS).toBe('已复制 APP 口令，打开夸克 APP 即可识别')
    expect(COPY_CODE_SUCCESS).toBe('提取码已复制')
    expect(DIAG_COPY_SUCCESS).toBe('诊断信息已复制，粘贴给作者即可')
  })

  it('更新提示块（UpdateDialog）文案逐字对齐', () => {
    expect(UPDATE_DIALOG_INTRO).toContain('下载安装包')
    expect(UPDATE_NO_DOWNLOAD_URL).toBe('本次没取到安装包直链，请用下方网盘获取。')
    expect(UPDATE_NOTES_EMPTY).toBe('（这个版本没有填写更新说明）')
    expect([UPDATE_DOWNLOAD_LABEL, UPDATE_CLOSE_LABEL, UPDATE_SKIP_LABEL]).toEqual([
      '下载安装包',
      '稍后提醒',
      '跳过此版本',
    ])
    expect(UPDATE_QUARK_NOTE).toBe('网盘由作者手动同步，可能稍慢于 Gitee。')
  })

  it('可见文案全中文（每条纯文案常量都含汉字）', () => {
    const texts: readonly string[] = [
      HELP_TITLE,
      HELP_TEXT_NORMAL,
      HELP_TEXT_PORTABLE,
      SECTION_AUTHOR,
      SECTION_DOWNLOAD,
      SECTION_MIGRATION,
      SECTION_CONTACT,
      SECTION_SUPPORT,
      SECTION_THANKS,
      AUTHOR_DESC,
      BILI_BUTTON_LABEL,
      SUPPORT_DESC,
      THANKS_NOTE,
      MIGRATION_DESC,
      DIAG_NOTE,
      DIAG_LABEL,
      DIAG_WAITING,
      CHECK_LABEL,
      AUTO_CHECK_LABEL,
      OPEN_QUARK_LABEL,
      QUARK_INVALID_NOTE,
      INSTALL_TIP_TEXT,
      PORTABLE_DOWNLOAD_NOTE,
      COPY_FAILURE,
      CLIPBOARD_HINT,
      COPY_TOKEN_SUCCESS,
      COPY_CODE_SUCCESS,
      DIAG_COPY_SUCCESS,
      UPDATE_DIALOG_INTRO,
      UPDATE_NO_DOWNLOAD_URL,
      UPDATE_NOTES_EMPTY,
      UPDATE_QUARK_NOTE,
      THANKS_EMPTY,
      LEGACY_FOUND,
      LEGACY_NOT_FOUND,
      LEGACY_NO_DATA,
      LEGACY_UNWIRED_NOTE,
      CHECK_UNWIRED_HINT,
      QUARK_UNWIRED_NOTE,
      AVATAR_PLACEHOLDER_NOTE,
    ]
    for (const text of texts) {
      expect(text, `文案「${text}」应为全中文`).toMatch(/[\u4e00-\u9fff]/)
    }
    expect(AVATAR_PLACEHOLDER_NOTE).toContain('头像图片')
  })
})

// ==================== 版本号 ====================

describe('about-model · 版本号展示', () => {
  it('null / 空串 / 「开发版」都退回「开发版」（不加 v 前缀）', () => {
    expect(formatVersionLabel(null)).toBe(VERSION_FALLBACK)
    expect(formatVersionLabel(undefined)).toBe(VERSION_FALLBACK)
    expect(formatVersionLabel('')).toBe(VERSION_FALLBACK)
    expect(formatVersionLabel('   ')).toBe(VERSION_FALLBACK)
    expect(formatVersionLabel(VERSION_FALLBACK)).toBe(VERSION_FALLBACK)
  })

  it('正式版本加 v 前缀；已是 v 前缀不拼成 vv', () => {
    expect(formatVersionLabel('3.0.1')).toBe('v3.0.1')
    expect(formatVersionLabel('v3.0.1')).toBe('v3.0.1')
    expect(formatVersionLabel('V3.0.1')).toBe('v3.0.1')
    expect(formatVersionLabel(' 0.1.0 ')).toBe('v0.1.0')
  })

  it('构建时间空白即不展示', () => {
    expect(formatBuildAt(null)).toBeNull()
    expect(formatBuildAt('  ')).toBeNull()
    expect(formatBuildAt(' 2026-10-16T09:00:00+08:00 ')).toBe('2026-10-16T09:00:00+08:00')
  })

  it('回退函数：null / undefined 回退，空串按字符串语义回退', () => {
    expect(withFallback<readonly string[]>(undefined, THANKS)).toBe(THANKS)
    expect(withFallback<readonly string[]>(null, THANKS)).toBe(THANKS)
    expect(withStringFallback('', QUARK_URL)).toBe(QUARK_URL)
    expect(withStringFallback(undefined, QUARK_URL)).toBe(QUARK_URL)
    expect(withStringFallback(' https://example.com ', QUARK_URL)).toBe('https://example.com')
  })
})

// ==================== 更新检查四态 ====================

describe('about-model · 更新检查结果文案', () => {
  it('尚无结果时不出文案（对应上游 {result && ...}）', () => {
    expect(describeUpdateResult(null)).toBeNull()
    expect(describeUpdateResult(undefined)).toBeNull()
  })

  it('有更新 / 已跳过 / 已是最新 / 查不到：四态与上游一致', () => {
    expect(describeUpdateResult({ available: true, version: '3.1.0' })).toBe(
      `${UPDATE_HAS_NEW_PREFIX}v3.1.0`,
    )
    expect(describeUpdateResult({ available: false, skipped: true, version: '3.1.0' })).toBe(
      skippedLabel('3.1.0'),
    )
    expect(describeUpdateResult({ available: false, latestFound: true })).toBe(UPDATE_LATEST)
    expect(describeUpdateResult({ available: false })).toBe(UPDATE_UNKNOWN)
  })

  it('跳过态优先于「已是最新」；版本串缺失用「未知」占位，绝不吐 undefined', () => {
    expect(describeUpdateResult({ available: false, skipped: true, latestFound: true })).toBe(
      skippedLabel(VERSION_UNKNOWN),
    )
    const texts = [
      describeUpdateResult({ available: true }),
      describeUpdateResult({ available: false, skipped: true }),
      updateDialogTitle(undefined),
      updateVersionText('  '),
    ]
    for (const text of texts) {
      expect(text).not.toContain('undefined')
      expect(text).toContain(VERSION_UNKNOWN)
    }
  })

  it('弹窗标题逐字对齐 UpdateDialog：发现新版本 v{version}', () => {
    expect(updateDialogTitle('3.1.0')).toBe('发现新版本 v3.1.0')
    expect(updateDialogTitle(undefined)).toBe(`发现新版本 v${VERSION_UNKNOWN}`)
  })

  it('检查失败必须有中文提示；空白视为没有失败', () => {
    expect(describeCheckError(null)).toBeNull()
    expect(describeCheckError(undefined)).toBeNull()
    expect(describeCheckError('   ')).toBeNull()
    expect(describeCheckError('网络不可达')).toBe(`${CHECK_ERROR_PREFIX}网络不可达`)
    expect(CHECK_ERROR_PREFIX).toBe('检查更新失败：')
  })

  it('更新说明切块：按行去标记、去空行，绝不产生 HTML', () => {
    expect(splitUpdateNotes(null)).toEqual([])
    expect(splitUpdateNotes('   ')).toEqual([])
    expect(splitUpdateNotes('# 标题\r\n- 修复 A\n1. 修复 B\n> 提示\n\n')).toEqual([
      '标题',
      '修复 A',
      '修复 B',
      '提示',
    ])
    const lines = splitUpdateNotes('<img src=x onerror=alert(1)>')
    expect(lines).toEqual(['<img src=x onerror=alert(1)>'])
  })
})

// ==================== 旧版数据迁移 ====================

describe('about-model · 旧版数据探测结果', () => {
  it('没传探测结果时不出文案', () => {
    expect(describeLegacyProbe(null)).toBeNull()
    expect(describeLegacyProbe(undefined)).toBeNull()
  })

  it('先报「探测失败」再报「没找到」：失败与没有是两回事', () => {
    expect(describeLegacyProbe({ exists: false, error: 'EACCES' })).toEqual({
      tone: 'error',
      message: `${LEGACY_PROBE_ERROR_PREFIX}EACCES`,
    })
    expect(describeLegacyProbe({ exists: false })).toEqual({
      tone: 'info',
      message: LEGACY_NOT_FOUND,
    })
  })

  it('目录在但没有可导入数据 / 找到了可导入数据', () => {
    expect(describeLegacyProbe({ exists: true })).toEqual({ tone: 'info', message: LEGACY_NO_DATA })
    expect(describeLegacyProbe({ exists: true, jsonExists: false, idbExists: false })).toEqual({
      tone: 'info',
      message: LEGACY_NO_DATA,
    })
    expect(describeLegacyProbe({ exists: true, jsonExists: true })).toEqual({
      tone: 'info',
      message: LEGACY_FOUND,
    })
    expect(describeLegacyProbe({ exists: true, idbExists: true })).toEqual({
      tone: 'info',
      message: LEGACY_FOUND,
    })
  })

  it('空白 error 不算失败（否则探测正常也会报错）', () => {
    expect(describeLegacyProbe({ exists: true, jsonExists: true, error: '  ' })).toEqual({
      tone: 'info',
      message: LEGACY_FOUND,
    })
  })
})

// ==================== 剪贴板 ====================

describe('about-model · 剪贴板封装', () => {
  it('能力判定：缺 writeText / 非对象一律不可用', () => {
    expect(canUseClipboard(null)).toBe(false)
    expect(canUseClipboard(undefined)).toBe(false)
    expect(canUseClipboard({})).toBe(false)
    expect(canUseClipboard({ writeText: 'no' })).toBe(false)
    expect(canUseClipboard({ writeText: () => Promise.resolve() })).toBe(true)
  })

  it('复制成功 / 剪贴板缺失 / 写入拒绝都不抛出，只返回布尔', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    await expect(copyText({ writeText }, QUARK_CODE)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith(QUARK_CODE)

    await expect(copyText(undefined, QUARK_CODE)).resolves.toBe(false)
    await expect(copyText({}, QUARK_CODE)).resolves.toBe(false)

    const failing = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
    await expect(copyText({ writeText: failing }, QUARK_CODE)).resolves.toBe(false)
  })

  it('收款码占位说明带上对应标签', () => {
    expect(payPlaceholderNote('微信收款码')).toContain('微信收款码')
    expect(payPlaceholderNote('支付宝收款码')).toContain('支付宝收款码')
  })

  it('致谢暂空有专门文案，不与「致谢名单」标题混淆', () => {
    expect(THANKS_EMPTY).not.toBe(SECTION_THANKS)
    expect(THANKS_EMPTY).toContain('暂空')
  })
})