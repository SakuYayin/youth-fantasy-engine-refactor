<script setup lang="ts">
/**
 * 「关于打赏」面板（`tab.id = 'about'`）：作者信息 / 获取最新版本 / 旧版数据迁移 / 联系方式 /
 * 诊断信息 / 打赏支持 / 致谢名单 + 更新提示块（上游 `AboutPage.tsx` + `UpdateDialog.tsx`）。
 *
 * 数据入口：`PanelProps`（`state` / `tab`）+ 一组**全部可选**的额外 props（`AboutPanelInputs`，
 * 见 `about-model.ts`）。上游会自己联网 / 读文件 / 读写 localStorage 的动作，本仓一律改为
 * 「状态经 props 传入 + 动作经 emit 请求」：
 * - 版本：`appVersion` prop，缺省回退 `state.getSnapshot().appVersion`（订阅刷新，既有行为保留）；
 * - 更新检查：`update` / `checking` / `checkError` / `autoCheck` props，请求走
 *   `check-update` / `set-auto-check`（渲染层 CSP `connect-src 'none'`，面板本就不许联网）；
 * - 打开链接：一律 `emit('open-link', url, label)`，组件**不调** `window.open`；
 * - 旧版迁移：`legacyProbe` prop + `import-legacy-data`；诊断信息：`diagnostics` prop + `collect-diagnostics`；
 * - 收款码 / 头像：`wechatPayUrl` / `alipayPayUrl` / `authorAvatarUrl` props，缺省渲染占位说明。
 *
 * 额外 props 全可选是硬要求：`registry.ts` 把本面板登记为 `Component<PanelProps>`，
 * 不传任何额外 props 也必须照常渲染，并把「未接线」如实写出来（不许静默空白）。
 *
 * 可见文案全部来自 `about-model.ts` 常量；样式只用 `var(--yfe-*, #fallback)` + `<style scoped>`。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { YfeButton, YfePanel } from '@yfe/ui'

import {
  APP_NAME_EN,
  AUTHOR_DESC,
  AUTHOR_NAME,
  AUTO_CHECK_LABEL,
  AVATAR_PLACEHOLDER_NOTE,
  BILI_BUTTON_LABEL,
  BILI_URL,
  BUILD_AT_LABEL,
  CHECKING_LABEL,
  CHECK_LABEL,
  CHECK_UNWIRED_HINT,
  CLIPBOARD_HINT,
  CONTACT_LINKS,
  COPY_CODE_SUCCESS,
  COPY_FAILURE,
  COPY_LABEL,
  COPY_TOKEN_LABEL,
  COPY_TOKEN_SUCCESS,
  DIAG_BUSY_LABEL,
  DIAG_COPY_SUCCESS,
  DIAG_LABEL,
  DIAG_NOTE,
  DIAG_WAITING,
  DOWNLOAD_DESC_PREFIX,
  DOWNLOAD_DESC_SUFFIX,
  GITEE_RELEASES_URL,
  HELP_TEXT_NORMAL,
  HELP_TEXT_PORTABLE,
  HELP_TITLE,
  IMPORT_LEGACY_LABEL,
  INSTALL_TIP_LABEL,
  INSTALL_TIP_TEXT,
  LEGACY_UNWIRED_NOTE,
  MIGRATION_DESC,
  OPEN_QUARK_LABEL,
  PAGE_INTRO_APP,
  PAGE_INTRO_TAIL,
  PAY_ALIPAY_LABEL,
  PAY_WECHAT_LABEL,
  PORTABLE_DOWNLOAD_NOTE,
  PORTABLE_RELEASE_LABEL,
  QUARK_CODE,
  QUARK_CODE_LABEL,
  QUARK_INVALID_NOTE,
  QUARK_TOKEN,
  QUARK_UNWIRED_NOTE,
  QUARK_URL,
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
  UPDATE_NO_DOWNLOAD_URL,
  UPDATE_NOTES_EMPTY,
  UPDATE_QUARK_LABEL,
  UPDATE_QUARK_NOTE,
  UPDATE_SKIP_LABEL,
  UPDATE_DIALOG_ARIA,
  canUseClipboard,
  copyText,
  describeCheckError,
  describeLegacyProbe,
  describeUpdateResult,
  formatBuildAt,
  formatVersionLabel,
  payPlaceholderNote,
  splitUpdateNotes,
  updateDialogTitle,
  withStringFallback,
} from './about-model.js'
import type { AboutPanelInputs, PayCode } from './about-model.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps & AboutPanelInputs>()

/** 全部动作都只是「请求外壳去做」；面板自己既不开链接也不联网、不写存储。 */
const emit = defineEmits<{
  'check-update': []
  'set-auto-check': [on: boolean]
  'open-link': [url: string, label: string]
  'import-legacy-data': []
  'collect-diagnostics': []
  'skip-version': [version: string]
}>()

/* ==================== 版本（props 优先，回退快照订阅） ==================== */

const snapshotVersion = ref<string | null>(props.state.getSnapshot().appVersion)
const stopSubscribe = props.state.subscribe((snapshot) => {
  snapshotVersion.value = snapshot.appVersion
})
onBeforeUnmount(() => {
  stopSubscribe()
})

const versionLabel = computed<string>(() => formatVersionLabel(props.appVersion ?? snapshotVersion.value))
const buildAtLabel = computed<string | null>(() => formatBuildAt(props.buildAt))
const portable = computed<boolean>(() => props.portable === true)
const helpText = computed<string>(() => (portable.value ? HELP_TEXT_PORTABLE : HELP_TEXT_NORMAL))

/* ==================== 网盘 / 口令 ==================== */

/**
 * 网盘地址是上游内置常量（静态块逐字还原），没人传时照常可用；
 * 只有外壳**显式传空串**才表示「这条链接这次没有」——那时保留空值、不回落内置短链。
 */
const quarkUrl = computed<string>(() => (props.quarkUrl == null ? QUARK_URL : props.quarkUrl.trim()))
const quarkCode = computed<string>(() => withStringFallback(props.quarkCode, QUARK_CODE))
const quarkToken = computed<string>(() => withStringFallback(props.quarkToken, QUARK_TOKEN))
/** 外壳显式传空串 = 未接线：按 QUARK_UNWIRED_NOTE 说明，且打开按钮不发事件（空链接不 emit）。 */
const quarkUnwired = computed<boolean>(() => quarkUrl.value === '')

/* ==================== 更新检查（结果 / 失败都由 props 传入） ==================== */

const updateResult = computed<string | null>(() => describeUpdateResult(props.update))
const checkErrorText = computed<string | null>(() => describeCheckError(props.checkError))
/** 三个更新相关 props 一个都没传 = 外壳尚未接线，按钮点了也拿不到结果，必须说出来。 */
const checkUnwired = computed<boolean>(
  () => props.update == null && props.checking == null && props.checkError == null,
)

/** 受控开关镜像：点一下先按本地预期翻面，最终以 props.autoCheck 为准。 */
const autoCheckMirror = ref<boolean>(props.autoCheck === true)
watch(
  () => props.autoCheck,
  (value) => {
    if (value !== undefined) autoCheckMirror.value = value
  },
)

function onAutoCheckChange(event: Event): void {
  const on = event.target instanceof HTMLInputElement ? event.target.checked : false
  autoCheckMirror.value = on
  emit('set-auto-check', on)
}

/** 更新提示块：外壳推来「有新版本」就打开；关闭 / 跳过是本地动作（跳过本身要回传版本号）。 */
const dialogOpen = ref<boolean>(props.update?.available === true)
watch(
  () => props.update,
  (next) => {
    if (next?.available === true) dialogOpen.value = true
  },
)
const updateNotes = computed<readonly string[]>(() => splitUpdateNotes(props.update?.notes))
const updateVersionTitle = computed<string>(() => updateDialogTitle(props.update?.version))
const updateDownloadUrl = computed<string>(() => (props.update?.downloadUrl ?? '').trim())

function closeDialog(): void {
  dialogOpen.value = false
}

function skipVersion(): void {
  const version = (props.update?.version ?? '').trim()
  if (version !== '') emit('skip-version', version)
  dialogOpen.value = false
}

/* ==================== 旧版数据迁移 / 诊断信息 ==================== */

const legacyMessage = computed(() => describeLegacyProbe(props.legacyProbe))
const legacyUnwired = computed<boolean>(() => props.legacyProbe === undefined)

const diagRequested = ref<boolean>(false)
const diagBusy = ref<boolean>(false)
const diagMessage = ref<string | null>(null)

/** 诊断正文由外壳采集：没拿到就先发请求，拿到后再复制（复制失败要可见）。 */
function requestDiagnostics(): void {
  const text = (props.diagnostics ?? '').trim()
  if (text === '') {
    diagRequested.value = true
    diagMessage.value = DIAG_WAITING
    emit('collect-diagnostics')
    return
  }
  void copyDiagnostics(text)
}

watch(
  () => props.diagnostics,
  (text) => {
    if (!diagRequested.value) return
    const trimmed = (text ?? '').trim()
    if (trimmed === '') return
    diagRequested.value = false
    void copyDiagnostics(trimmed)
  },
)

/** 「采集中…」只在真的在复制时短暂出现：采集本身在外壳那边，面板不等它。 */
async function copyDiagnostics(text: string): Promise<void> {
  diagBusy.value = true
  try {
    const ok = await copyToClipboard(text)
    diagMessage.value = ok ? DIAG_COPY_SUCCESS : COPY_FAILURE
  } finally {
    diagBusy.value = false
  }
}

/* ==================== 复制 / 打开链接 ==================== */

const copyMessage = ref<string | null>(null)
const clipboardAvailable = canUseClipboard(currentClipboard())

/** happy-dom / 无剪贴板环境里 `navigator.clipboard` 可能不存在，取用前先判空。 */
function currentClipboard(): unknown {
  if (typeof navigator === 'undefined') return null
  return navigator.clipboard
}

async function copyOut(text: string, success: string): Promise<void> {
  const ok = await copyText(currentClipboard(), text)
  copyMessage.value = ok ? success : COPY_FAILURE
}

/** 复制到剪贴板并回传是否成功（诊断信息有**自己的**提示位，不能写进夸克那块）。 */
async function copyToClipboard(text: string): Promise<boolean> {
  return await copyText(currentClipboard(), text)
}

/** 打开链接一律走事件：外壳负责 `shell.openExternal`，面板不碰 `window.open`。 */
function openExternal(url: string, label: string): void {
  const target = url.trim()
  if (target === '') return
  emit('open-link', target, label)
}

/* ==================== 收款码 / 致谢 ==================== */

const payCodes = computed<readonly PayCode[]>(() => [
  { key: 'wechat', label: PAY_WECHAT_LABEL, url: (props.wechatPayUrl ?? '').trim() },
  { key: 'alipay', label: PAY_ALIPAY_LABEL, url: (props.alipayPayUrl ?? '').trim() },
])
const avatarUrl = computed<string>(() => (props.authorAvatarUrl ?? '').trim())
const thanksList = computed<readonly string[]>(() => props.thanks ?? THANKS)
</script>

<template>
  <section class="panel-about" data-testid="panel-about">
    <header class="panel-about__header">
      <div class="panel-about__heading">
        <h2 class="panel-about__title">{{ tab.name }}</h2>
        <details class="panel-about__help">
          <summary class="panel-about__help-toggle" data-testid="about-help-toggle">{{ HELP_TITLE }}</summary>
          <p class="panel-about__help-text" data-testid="about-help-text">{{ helpText }}</p>
        </details>
      </div>
      <p class="panel-about__intro" data-testid="about-intro">
        {{ PAGE_INTRO_APP }}<span class="panel-about__intro-en">{{ APP_NAME_EN }}</span>{{ PAGE_INTRO_TAIL }}
      </p>
    </header>

    <div class="panel-about__grid">
      <div class="panel-about__col">
        <!-- ========== 作者信息 ========== -->
        <YfePanel :title="SECTION_AUTHOR">
          <div class="panel-about__author">
            <div class="panel-about__avatar">
              <img
                v-if="avatarUrl !== ''"
                class="panel-about__avatar-img"
                :src="avatarUrl"
                :alt="AUTHOR_NAME"
                data-testid="about-author-avatar"
              />
              <p v-else class="panel-about__placeholder" data-testid="about-avatar-placeholder">
                {{ AVATAR_PLACEHOLDER_NOTE }}
              </p>
            </div>
            <div class="panel-about__author-body">
              <p class="panel-about__author-name" data-testid="about-author-name">{{ AUTHOR_NAME }}</p>
              <p class="panel-about__author-desc" data-testid="about-author-desc">{{ AUTHOR_DESC }}</p>
              <YfeButton
                :label="BILI_BUTTON_LABEL"
                variant="primary"
                data-testid="about-open-bili"
                @click="openExternal(BILI_URL, BILI_BUTTON_LABEL)"
              />
            </div>
          </div>
        </YfePanel>

        <!-- ========== 获取最新版本 ========== -->
        <YfePanel :title="SECTION_DOWNLOAD">
          <p class="panel-about__desc" data-testid="about-download-desc">
            {{ DOWNLOAD_DESC_PREFIX }}<span class="panel-about__version" data-testid="about-version">{{ versionLabel }}</span>{{ DOWNLOAD_DESC_SUFFIX }}
          </p>
          <p v-if="buildAtLabel !== null" class="panel-about__build" data-testid="about-build-at">
            {{ BUILD_AT_LABEL }}{{ buildAtLabel }}
          </p>

          <p class="panel-about__tip" data-testid="about-install-tip">
            <strong class="panel-about__tip-label">{{ INSTALL_TIP_LABEL }}</strong>{{ INSTALL_TIP_TEXT }}
          </p>

          <!-- 便携版：不做任何联网检查，只给静态下载指引（上游 `:161-165`）。 -->
          <template v-if="portable">
            <p class="panel-about__note" data-testid="about-portable-note">{{ PORTABLE_DOWNLOAD_NOTE }}</p>
            <div class="panel-about__actions">
              <YfeButton
                :label="PORTABLE_RELEASE_LABEL"
                variant="primary"
                data-testid="about-open-release"
                @click="openExternal(GITEE_RELEASES_URL, PORTABLE_RELEASE_LABEL)"
              />
            </div>
          </template>

          <!-- 常规版：手动检查更新 + 启动时自动检查（都是请求外壳，面板不联网）。 -->
          <template v-else>
            <div class="panel-about__update">
              <YfeButton
                :label="checking === true ? CHECKING_LABEL : CHECK_LABEL"
                :loading="checking === true"
                :disabled="checking === true"
                data-testid="about-check-update"
                @click="emit('check-update')"
              />
              <label class="panel-about__auto">
                <input
                  type="checkbox"
                  class="panel-about__auto-box"
                  data-testid="about-auto-check"
                  :checked="autoCheckMirror"
                  @change="onAutoCheckChange"
                />
                <span class="panel-about__auto-label">{{ AUTO_CHECK_LABEL }}</span>
              </label>
            </div>
            <p
              v-if="updateResult !== null"
              class="panel-about__result"
              data-testid="about-update-result"
            >{{ updateResult }}</p>
            <p
              v-if="checkErrorText !== null"
              class="panel-about__failure"
              data-testid="about-check-error"
            >{{ checkErrorText }}</p>
            <p v-if="checkUnwired" class="panel-about__note" data-testid="about-check-unwired">
              {{ CHECK_UNWIRED_HINT }}
            </p>

            <!-- 更新提示块（上游 `UpdateDialog`：说明 + 下载 / 网盘 / 稍后 / 跳过）。 -->
            <section
              v-if="dialogOpen"
              class="panel-about__dialog"
              role="region"
              :aria-label="UPDATE_DIALOG_ARIA"
              data-testid="about-update-dialog"
            >
              <h3 class="panel-about__dialog-title" data-testid="about-update-dialog-title">
                {{ updateVersionTitle }}
              </h3>
              <p class="panel-about__dialog-intro">{{ UPDATE_DIALOG_INTRO }}</p>
              <div class="panel-about__notes" data-testid="about-update-notes">
                <p v-if="updateNotes.length === 0" class="panel-about__note" data-testid="about-update-notes-empty">
                  {{ UPDATE_NOTES_EMPTY }}
                </p>
                <ul v-else class="panel-about__note-list">
                  <li
                    v-for="(line, index) in updateNotes"
                    :key="index"
                    class="panel-about__note-item"
                    data-testid="about-update-note-line"
                  >{{ line }}</li>
                </ul>
              </div>
              <p v-if="updateDownloadUrl === ''" class="panel-about__note" data-testid="about-update-no-download">
                {{ UPDATE_NO_DOWNLOAD_URL }}
              </p>
              <div class="panel-about__actions">
                <YfeButton
                  :label="UPDATE_DOWNLOAD_LABEL"
                  variant="primary"
                  :disabled="updateDownloadUrl === ''"
                  data-testid="about-update-download"
                  @click="openExternal(updateDownloadUrl, UPDATE_DOWNLOAD_LABEL)"
                />
                <YfeButton
                  :label="UPDATE_QUARK_LABEL"
                  data-testid="about-update-quark"
                  @click="openExternal(quarkUrl, UPDATE_QUARK_LABEL)"
                />
                <YfeButton
                  :label="UPDATE_CLOSE_LABEL"
                  data-testid="about-update-close"
                  @click="closeDialog"
                />
                <YfeButton
                  :label="UPDATE_SKIP_LABEL"
                  data-testid="about-update-skip"
                  @click="skipVersion"
                />
              </div>
              <p class="panel-about__note" data-testid="about-update-quark-note">{{ UPDATE_QUARK_NOTE }}</p>
            </section>

            <div class="panel-about__actions">
              <YfeButton
                :label="OPEN_QUARK_LABEL"
                variant="primary"
                data-testid="about-open-quark"
                @click="openExternal(quarkUrl, OPEN_QUARK_LABEL)"
              />
              <YfeButton
                :label="COPY_TOKEN_LABEL"
                data-testid="about-copy-token"
                @click="copyOut(quarkToken, COPY_TOKEN_SUCCESS)"
              />
              <span class="panel-about__code-row">
                <span class="panel-about__code-label">{{ QUARK_CODE_LABEL }}</span>
                <code class="panel-about__code" data-testid="about-quark-code">{{ quarkCode }}</code>
                <YfeButton
                  :label="COPY_LABEL"
                  data-testid="about-copy-code"
                  @click="copyOut(quarkCode, COPY_CODE_SUCCESS)"
                />
              </span>
            </div>
            <p v-if="quarkUnwired" class="panel-about__note" data-testid="about-quark-unwired">
              {{ QUARK_UNWIRED_NOTE }}
            </p>
            <p class="panel-about__note" data-testid="about-quark-invalid-note">{{ QUARK_INVALID_NOTE }}</p>
            <p
              v-if="copyMessage !== null"
              class="panel-about__result"
              :class="{ 'panel-about__result--failure': copyMessage === COPY_FAILURE }"
              data-testid="about-copy-result"
            >{{ copyMessage }}</p>
            <p v-if="clipboardAvailable === false" class="panel-about__note" data-testid="about-clipboard-hint">
              {{ CLIPBOARD_HINT }}
            </p>
          </template>
        </YfePanel>

        <!-- ========== 旧版数据迁移 ========== -->
        <YfePanel :title="SECTION_MIGRATION">
          <p class="panel-about__desc" data-testid="about-migration-desc">{{ MIGRATION_DESC }}</p>
          <p v-if="legacyUnwired" class="panel-about__note" data-testid="about-legacy-unwired">
            {{ LEGACY_UNWIRED_NOTE }}
          </p>
          <p
            v-else-if="legacyMessage !== null"
            class="panel-about__result"
            :class="{ 'panel-about__result--failure': legacyMessage.tone === 'error' }"
            data-testid="about-legacy-result"
          >{{ legacyMessage.message }}</p>
          <div class="panel-about__actions">
            <YfeButton
              :label="IMPORT_LEGACY_LABEL"
              data-testid="about-import-legacy"
              @click="emit('import-legacy-data')"
            />
          </div>
        </YfePanel>

        <!-- ========== 联系方式 + 诊断信息 ========== -->
        <YfePanel :title="SECTION_CONTACT">
          <ul class="panel-about__contacts" data-testid="about-contact-list">
            <li
              v-for="link in CONTACT_LINKS"
              :key="link.label"
              class="panel-about__contact"
              data-testid="about-contact-item"
            >
              <span class="panel-about__contact-label">{{ link.label }}</span>
              <span class="panel-about__contact-value">{{ link.value }}</span>
            </li>
          </ul>
          <div class="panel-about__diag">
            <YfeButton
              :label="diagBusy ? DIAG_BUSY_LABEL : DIAG_LABEL"
              :loading="diagBusy"
              :disabled="diagBusy"
              data-testid="about-copy-diagnostics"
              @click="requestDiagnostics"
            />
            <p class="panel-about__note" data-testid="about-diag-note">{{ DIAG_NOTE }}</p>
            <p
              v-if="diagMessage !== null"
              class="panel-about__result"
              :class="{ 'panel-about__result--failure': diagMessage === COPY_FAILURE }"
              data-testid="about-diag-result"
            >
              {{ diagMessage }}
            </p>
          </div>
        </YfePanel>
      </div>

      <!-- ========== 打赏支持 + 致谢名单 ========== -->
      <div class="panel-about__col panel-about__col--support">
        <YfePanel :title="SECTION_SUPPORT">
          <p class="panel-about__desc" data-testid="about-support-desc">{{ SUPPORT_DESC }}</p>
          <div class="panel-about__pay">
            <div
              v-for="code in payCodes"
              :key="code.key"
              class="panel-about__pay-item"
              :data-testid="`about-pay-${code.key}`"
            >
              <img
                v-if="code.url !== ''"
                class="panel-about__pay-img"
                :src="code.url"
                :alt="code.label"
                :data-testid="`about-pay-img-${code.key}`"
              />
              <p
                v-else
                class="panel-about__placeholder"
                :data-testid="`about-pay-placeholder-${code.key}`"
              >{{ payPlaceholderNote(code.label) }}</p>
              <p class="panel-about__pay-label">{{ code.label }}</p>
            </div>
          </div>

          <h3 class="panel-about__sub" data-testid="about-thanks-title">{{ SECTION_THANKS }}</h3>
          <p class="panel-about__note" data-testid="about-thanks-note">{{ THANKS_NOTE }}</p>
          <ul v-if="thanksList.length > 0" class="panel-about__thanks" data-testid="about-thanks-list">
            <li
              v-for="name in thanksList"
              :key="name"
              class="panel-about__thank"
              data-testid="about-thank-item"
            >{{ name }}</li>
          </ul>
          <p v-else class="panel-about__note" data-testid="about-thanks-empty">{{ THANKS_EMPTY }}</p>
        </YfePanel>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-about {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.panel-about__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.panel-about__heading {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.panel-about__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: 600;
}

.panel-about__help-toggle {
  cursor: pointer;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__help-text {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
  white-space: pre-line;
}

.panel-about__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__intro-en {
  font-family: var(--yfe-font-family-mono, 'Cascadia Mono', Consolas, monospace);
}

.panel-about__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--yfe-space-lg, 16px);
}

.panel-about__col {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  min-width: 0;
}

@media (min-width: 1024px) {
  .panel-about__grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    align-items: start;
  }
}

.panel-about__desc,
.panel-about__tip,
.panel-about__build {
  margin: 0 0 var(--yfe-space-sm, 8px);
  line-height: 1.7;
}

.panel-about__build {
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__tip {
  border-left: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #33384a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-alt, #1b1e29);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__tip-label {
  color: var(--yfe-color-warning, #e0a33a);
}

.panel-about__version {
  color: var(--yfe-color-accent, #d7a35b);
  font-family: var(--yfe-font-family-mono, 'Cascadia Mono', Consolas, monospace);
}

.panel-about__author {
  display: flex;
  align-items: flex-start;
  gap: var(--yfe-space-md, 12px);
}

.panel-about__avatar {
  flex: none;
  width: 72px;
}

.panel-about__avatar-img {
  width: 72px;
  height: 72px;
  border-radius: var(--yfe-radius-full, 999px);
  object-fit: cover;
}

.panel-about__placeholder {
  margin: 0;
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #33384a);
  border-radius: var(--yfe-radius-md, 6px);
  padding: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-xs, 12px);
  line-height: 1.6;
  text-align: center;
}

.panel-about__author-body {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  min-width: 0;
}

.panel-about__author-name {
  margin: 0;
  font-weight: 600;
}

.panel-about__author-desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.7;
}

.panel-about__update,
.panel-about__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  margin-top: var(--yfe-space-sm, 8px);
}

.panel-about__auto {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
  cursor: pointer;
}

.panel-about__code-row {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.panel-about__code-label {
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__code {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #33384a);
  border-radius: var(--yfe-radius-sm, 4px);
  padding: 0 var(--yfe-space-xs, 4px);
  font-family: var(--yfe-font-family-mono, 'Cascadia Mono', Consolas, monospace);
}

.panel-about__result {
  margin: var(--yfe-space-sm, 8px) 0 0;
  color: var(--yfe-color-success, #4a9d6a);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__result--failure,
.panel-about__failure {
  margin: var(--yfe-space-sm, 8px) 0 0;
  color: var(--yfe-color-danger, #d0554f);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__note {
  margin: var(--yfe-space-xs, 4px) 0;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-xs, 12px);
  line-height: 1.7;
}

.panel-about__dialog {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin-top: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #33384a);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-surface-alt, #1b1e29);
  padding: var(--yfe-space-md, 12px);
}

.panel-about__dialog-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: 600;
  color: var(--yfe-color-warning, #e0a33a);
}

.panel-about__dialog-intro {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.7;
}

.panel-about__note-list {
  margin: 0;
  padding-left: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.7;
}

.panel-about__contacts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.panel-about__contact {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__contact-label {
  flex: none;
  color: var(--yfe-color-text-muted, #9aa0ae);
}

.panel-about__contact-value {
  color: var(--yfe-color-text, #e6e8ee);
}

.panel-about__diag {
  margin-top: var(--yfe-space-md, 12px);
}

.panel-about__pay {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
  margin-top: var(--yfe-space-sm, 8px);
}

.panel-about__pay-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  min-width: 140px;
}

.panel-about__pay-img {
  width: 140px;
  height: 140px;
  border-radius: var(--yfe-radius-md, 6px);
  object-fit: contain;
}

.panel-about__pay-label {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0ae);
  font-size: var(--yfe-font-size-xs, 12px);
}

.panel-about__sub {
  margin: var(--yfe-space-lg, 16px) 0 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: 600;
}

.panel-about__thanks {
  margin: var(--yfe-space-xs, 4px) 0 0;
  padding-left: var(--yfe-space-lg, 16px);
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-xs, 4px) var(--yfe-space-md, 12px);
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-sm, 13px);
}

.panel-about__thank {
  list-style: disc;
}
</style>