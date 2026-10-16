/**
 * Electron 主进程入口。
 *
 * 进程职责（重构文档 02 的进程职责表）：
 * - main：窗口、菜单、IPC 路由、生命周期。**不跑索引、不解析整库、不写 SQL、不发模型长请求。**
 * - db-worker（子进程）：数据库唯一的持有者，见 `./db-worker.mjs`。
 * - renderer：沙箱化，只能通过 preload 暴露的白名单方法调用 main。
 *
 * 三种运行方式：
 *
 * 1. `node src/main/main.mjs --self-check [--db-path=<file>]`：**无 GUI 自检**。
 *    真起 worker、真开库、真跑一遍用例链，把 JSON 打到 stdout。
 * 2. `electron .`（或 `npm run dev -w @yfe/desktop`）：正常桌面模式。
 *    主进程进入事件循环等用户关窗；**绝不 `process.exit`**。
 * 3. `electron . --gui-check [--db-path=<file>]`：**真窗口自检**。
 *    在 renderer 世界里断言 preload 桥、Vue 挂载、编辑器、CSP 与真 IPC 往返，
 *    打 JSON 后退出（0/1）。用于「本机能真的弹出窗口并跑通」的可复现验收。
 *
 * Windows 工作区 Low Integrity ACL 的启动问题由开发启动器缓存完整运行时解决。
 * `YFE_DISABLE_SANDBOX=1` / `--no-sandbox` 仅用于显式对照实验，不能视为修复；
 * 默认保持沙箱开启，生产与正常开发不设置该开关。
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceHost } from './service-host.mjs';
import { createCloseGuard } from './close-guard.mjs';
import { createAiClient } from './ai-client.mjs';
import { collectEditorChecks } from './gui-editor-check.mjs';
import { rendererDevUrl, isRendererUrl, isExternalUrl, isTrustedSender } from './renderer-policy.mjs';
import ipcMethodsModule from '../preload/ipc-methods.cjs';

const { IPC_METHODS } = ipcMethodsModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const IPC_CHANNEL = 'yfe:invoke';
const WORKER_PATH = join(HERE, 'db-worker.mjs');
const PRELOAD_PATH = join(HERE, '..', 'preload', 'preload.cjs');
const DB_FILE_NAME = 'youth-fantasy-engine.db';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_WORKER_RESTARTS = 3;

// ---------------------------------------------------------------------------
// 结构化日志（JSON 一行一条；requestId 串联，见设计文档 04）
// ---------------------------------------------------------------------------
/** @type {((line: string) => void) | null} */
let logSink = null;

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function log(level, message, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: 'main', message, ...extra });
  if (logSink) {
    try {
      logSink(line);
      return;
    } catch {
      // 落盘失败也不能让日志本身炸掉主进程
    }
  }
  process.stderr.write(`${line}\n`);
}

/**
 * @param {string} method
 * @param {{ok: true, value: unknown} | {ok: false, error: Record<string, unknown>}} result
 * @param {string} [fallbackRequestId]
 */
function toEnvelope(method, result, fallbackRequestId = 'unknown') {
  if (result && result.ok === true) {
    return { kind: 'response', requestId: fallbackRequestId, ok: true, method, value: result.value };
  }
  const error = (result && result.error) || {};
  return {
    kind: 'response',
    requestId: typeof error.requestId === 'string' ? error.requestId : fallbackRequestId,
    ok: false,
    method,
    error,
  };
}

/**
 * @param {string} method
 * @param {string} code
 * @param {string} message
 */
function localFailureEnvelope(method, code, message) {
  const requestId = randomUUID();
  return {
    kind: 'response',
    requestId,
    ok: false,
    method: String(method),
    error: { code, message, requestId, severity: 'warn', retryable: false },
  };
}

// ---------------------------------------------------------------------------
// 服务宿主（Electron 与自检共用同一份装配）
// ---------------------------------------------------------------------------
/**
 * @param {string} dbPath
 * @param {{onReady?: (host: any) => void}} [hooks]
 */
function createHost(dbPath, hooks = {}) {
  const host = createServiceHost({
    workerPath: WORKER_PATH,
    execPath: process.execPath,
    // 🔴 Electron 的 process.execPath 是 electron.exe；不加这个开关子进程会
    //    试图启动 GUI 而不是当 Node 用。纯 node 下该变量无害。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxRestarts: MAX_WORKER_RESTARTS,
    onDiagnostic: (entry) => {
      const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
      log(level, entry.message, { scope: 'db-worker', at: entry.at });
    },
  });
  hooks.onReady?.(host);
  return host;
}

// ---------------------------------------------------------------------------
// 无 GUI 自检（task-8 验收路径）
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = { selfCheck: false, guiCheck: false, dbPath: null, help: false };
  for (const arg of argv) {
    if (arg === '--self-check') flags.selfCheck = true;
    else if (arg === '--gui-check') flags.guiCheck = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--db-path=')) flags.dbPath = arg.slice('--db-path='.length);
  }
  return flags;
}

function resolveDbPath(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const dataDir = process.env.YFE_DATA_DIR ?? join(process.cwd(), '.yfe-data');
  return join(dataDir, DB_FILE_NAME);
}

/**
 * 从用例输出里取实体 id。用例层的权威形状是 `{projectId}` / `{documentId}`
 * （见 `packages/contracts/src/commands/index.ts` 的 `ProjectCreateOutput` /
 * `DocumentCreateOutput`），Repository 层则可能回 `{project:{id}}`、`{id}` 或直接字符串。
 * 自检不预设某一种，按最常见顺序探测。
 *
 * 🔴 `bag[`${key}Id`]` 这一项是必须的：用例层返回的是 `projectId` 而不是 `project.id`，
 * 少了它自检会取到 null 并**静默跳过整条链路后假绿**。
 * @param {unknown} value
 * @param {string} key
 * @returns {string | null}
 */
function pickId(value, key) {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : null;
  const bag = /** @type {Record<string, any>} */ (value);
  for (const candidate of [bag[`${key}Id`], bag[key]?.id, bag.id, bag[key], bag.entity?.id]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * 从 getDocument 输出里取正文。
 * @param {unknown} value
 * @param {string} documentId
 * @returns {string | null}
 */
function pickBody(value, documentId) {
  if (!value || typeof value !== 'object') return null;
  const bag = /** @type {Record<string, any>} */ (value);
  for (const candidate of [bag.document?.body, bag.body, bag.document?.content, bag.content]) {
    if (typeof candidate === 'string') return candidate;
  }
  // 有的实现返回 {documents:[...]} 或按 id 建的映射
  if (Array.isArray(bag.documents)) {
    const hit = bag.documents.find((row) => row && row.id === documentId);
    if (hit && typeof hit.body === 'string') return hit.body;
  }
  return null;
}

async function runSelfCheck(dbPath) {
  log('info', '自检开始（无 GUI）', { dbPath });
  const host = createHost(dbPath);
  /** @type {Array<{step: string, ok: boolean, detail: string}>} */
  const steps = [];
  const record = (step, ok, detail) => steps.push({ step, ok, detail: String(detail) });

  try {
    await host.start();
    record('host.start', true, 'worker 就绪');

    const opened = await host.open(dbPath);
    record('open', opened.ok === true, opened.ok ? `schemaVersion=${opened.value.schemaVersion}` : JSON.stringify(opened.error));
    if (!opened.ok) throw new Error('open 失败，后续步骤无意义');

    const status = await host.call('systemStatus', null);
    record('systemStatus', status.ok === true, status.ok ? JSON.stringify(status.value) : JSON.stringify(status.error));

    // 用例链：**用上一步真实返回的 id 串联**（不是硬编码），这样 task-3/task-7
    // 一落地这里就是真正的端到端验收。任一环缺依赖就停在那里，绝不静默跳过。
    const workspaceId = randomUUID();
    const baseContext = () => ({ requestId: randomUUID(), workspaceId });

    const created = await host.call('createProject', { context: baseContext(), name: '自检作品' });
    record('createProject', created.ok === true, created.ok === true ? JSON.stringify(created.value) : JSON.stringify(created.error));
    const projectId = created.ok === true ? pickId(created.value, 'project') : null;

    if (!projectId) {
      // 🔴 不许静默跳过：取不到 id 说明链路没跑完，必须记一条红的；
      // 否则「依赖缺失」会伪装成 failedCount=0 的假绿。
      record(
        'createProject.id',
        false,
        `未从 createProject 输出取到 projectId：${JSON.stringify(created.ok === true ? created.value : created.error)}`,
      );
    } else {
      const tree = await host.call('listDocumentTree', { context: baseContext(), projectId });
      record('listDocumentTree', tree.ok === true, tree.ok === true ? JSON.stringify(tree.value) : JSON.stringify(tree.error));

      const document = await host.call('createDocument', {
        context: { ...baseContext(), projectId },
        projectId,
        kind: 'chapter',
        parentId: null,
        title: '第一章',
        placement: { mode: 'end' },
      });
      record('createDocument', document.ok === true, document.ok === true ? JSON.stringify(document.value) : JSON.stringify(document.error));
      const documentId = document.ok === true ? pickId(document.value, 'document') : null;

      if (!documentId) {
        record(
          'createDocument.id',
          false,
          `未从 createDocument 输出取到 documentId：${JSON.stringify(document.ok === true ? document.value : document.error)}`,
        );
      } else {
        const body = '自检正文：中文往返、emoji🙂、换行\n第二行';
        const saved = await host.call('saveDraft', {
          context: { ...baseContext(), projectId },
          documentId,
          draftSequence: 1,
          body,
          sessionId: 'self-check-session',
        });
        record('saveDraft', saved.ok === true, saved.ok === true ? JSON.stringify(saved.value) : JSON.stringify(saved.error));

        const read = await host.call('getDocument', { context: baseContext(), documentId });
        record('getDocument', read.ok === true, read.ok === true ? JSON.stringify(read.value) : JSON.stringify(read.error));

        // 🔴 正文往返是硬验收项：中文与 emoji 必须逐字相等。
        const readBack = read.ok === true ? pickBody(read.value, documentId) : null;
        record('正文往返（含中文/emoji/换行）', readBack === body, `写入=${JSON.stringify(body)} 读回=${JSON.stringify(readBack)}`);

        // 乐观锁双向验证：
        // ① expectedRevision = 库内当前版本 → 必须被接受并推进 revision；
        // ② 再用**已经过期**的 revision 写一次 → 必须被拒为 REVISION_CONFLICT。
        // 只测②会让「CAS 没生效」和「CAS 生效」看起来一样，所以两个方向都要验。
        if (saved.ok === true && typeof saved.value?.revision === 'string') {
          const currentRevision = saved.value.revision;
          const advanced = await host.call('saveDraft', {
            context: { ...baseContext(), projectId, expectedRevision: currentRevision },
            documentId,
            draftSequence: 2,
            body: '基于最新版本的写入',
            sessionId: 'self-check-session',
          });
          record(
            '乐观锁：expectedRevision=当前版本应被接受',
            advanced.ok === true,
            JSON.stringify(advanced.ok === true ? advanced.value : advanced.error),
          );

          if (advanced.ok === true) {
            const conflicting = await host.call('saveDraft', {
              context: { ...baseContext(), projectId, expectedRevision: currentRevision },
              documentId,
              draftSequence: 3,
              body: '基于旧版本的写入',
              sessionId: 'self-check-session',
            });
            const rejected = conflicting.ok === false && conflicting.error?.code === 'REVISION_CONFLICT';
            record(
              '乐观锁：过期 revision 必须被拒（REVISION_CONFLICT）',
              rejected,
              JSON.stringify(conflicting.ok === true ? conflicting.value : conflicting.error),
            );
          }
        } else {
          record('乐观锁：expectedRevision=当前版本应被接受', false, `saveDraft 未返回 revision：${JSON.stringify(saved.value ?? saved.error)}`);
        }
      }
    }
  } catch (thrown) {
    record('self-check', false, thrown instanceof Error ? thrown.message : String(thrown));
  } finally {
    await host.shutdown();
  }

  const stats = host.stats();
  const failed = steps.filter((s) => !s.ok);
  const payload = {
    // 严格判定：任一环没过就是没过。依赖未落地时必须红，绝不假装绿。
    ok: failed.length === 0,
    dbPath,
    steps,
    failedCount: failed.length,
    host: stats,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Electron 模式
// ---------------------------------------------------------------------------

/**
 * 浏览器进程沙箱例外的**兜底**处理。
 *
 * 启动器把显式实验开关转成命令行参数。这里保留兜底与日志；
 * 退出码变化本身不足以判断崩溃来源，也不足以证明 GUI 已恢复。
 * @param {any} app
 * @returns {boolean}
 */
function applySandboxOverride(app) {
  const requested = process.env.YFE_DISABLE_SANDBOX === '1' || process.argv.includes('--no-sandbox');
  if (!requested) return false;
  const onCommandLine = process.argv.includes('--no-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
  if (!onCommandLine) {
    log('warn', '检测到 YFE_DISABLE_SANDBOX=1 但命令行缺少 --no-sandbox：本机沙箱很可能仍会崩，请用启动器', {
      hint: 'npm run dev:no-sandbox -w @yfe/desktop（或 node bin/dev-desktop.mjs --no-sandbox）',
    });
  }
  log('warn', '已关闭 Chromium 沙箱：仅限本机验证，勿用于生产/安全验收', {
    electron: process.versions.electron,
    consequence: 'renderer 失去 OS 级隔离；webPreferences.sandbox 名义为 true 但实际失效',
  });
  return true;
}

/**
 * `--gui-check` 在**真窗口**里跑的脚本。
 *
 * 必须跑在 renderer 世界（`executeJavaScript` 默认主世界），这样才证明
 * preload → IPC → db-worker → SQLite 整条链路，而不是 Node 侧自说自话。
 * CSP 两条断言也是真的：页面内 `eval` 与跨源 `fetch` 受 `index.html` 的 meta CSP 约束。
 *
 * 🔴 这里不用模板字面量与 `\n`：外层已经是模板字面量，`${` 会被提前求值，
 *    `\n` 会被折成真换行并破坏内层字符串。因此统一用单引号拼接与 `String.fromCharCode(10)`。
 */
const GUI_CHECK_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (predicate()) return true; } catch (error) { void error; }
      await sleep(50);
    }
    try { return predicate() === true; } catch (error) { void error; return false; }
  };

  const bridge = window.yfe;
  const mounted = await waitFor(() => {
    const root = document.querySelector('#app');
    return root !== null && root.children.length > 0;
  }, 12000);
  const editorPresent = await waitFor(() => document.querySelector('.cm-editor') !== null, 8000);

  let evalBlocked = false;
  try { (0, eval)('1 + 1'); } catch (error) { void error; evalBlocked = true; }
  let fetchBlocked = false;
  try { await fetch('http://127.0.0.1:9/gui-check'); } catch (error) { void error; fetchBlocked = true; }

  const root = document.querySelector('#app');
  const out = {
    bridge: { call: typeof bridge?.call === 'function', methods: Array.isArray(bridge?.methods) ? bridge.methods : null },
    dom: {
      mounted: mounted,
      appChildren: root === null ? -1 : root.children.length,
      editorPresent: editorPresent,
      textLength: (document.body.innerText || '').trim().length,
      text: (document.body.innerText || '').trim().slice(0, 100),
    },
    csp: { evalBlocked: evalBlocked, fetchBlocked: fetchBlocked },
  };
  if (typeof bridge?.call !== 'function') return out;

  const workspaceId = 'ws_gui_check';
  const context = () => ({ requestId: 'gui-check-' + Math.random().toString(16).slice(2), workspaceId });
  out.status = await bridge.call('systemStatus', null);
  out.project = await bridge.call('createProject', { context: context(), name: 'GUI 自检作品' });
  const projectId = out.project && out.project.ok === true && out.project.value
    ? (out.project.value.projectId || (out.project.value.project && out.project.value.project.id) || null)
    : null;
  out.created = await bridge.call('createDocument', {
    context: Object.assign({}, context(), { projectId: projectId }),
    projectId: projectId,
    kind: 'chapter',
    parentId: null,
    title: 'GUI 自检第一章',
    placement: { mode: 'end' },
  });
  const documentId = out.created && out.created.ok === true && out.created.value
    ? (out.created.value.documentId || (out.created.value.document && out.created.value.document.id) || null)
    : null;
  out.body = 'GUI 自检正文：中文、emoji🙂、换行' + String.fromCharCode(10) + '第二行';
  out.saved = await bridge.call('saveDraft', {
    context: Object.assign({}, context(), { projectId: projectId }),
    documentId: documentId,
    draftSequence: 1,
    body: out.body,
    sessionId: 'gui-check-session',
  });
  out.loaded = await bridge.call('getDocument', { context: context(), documentId: documentId });
  return out;
})()`;

/**
 * 把 renderer 返回的原始结果翻成断言表（判定放在 Node 侧，便于复用 pickId/pickBody）。
 * @param {any} window
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}>}
 */
async function collectGuiChecks(window) {
  const raw = await window.webContents.executeJavaScript(GUI_CHECK_SCRIPT, true);
  /** @type {Array<{name: string, ok: boolean, detail: string}>} */
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: String(detail ?? '') });

  const bridge = raw?.bridge ?? {};
  push('preload.bridge', bridge.call === true, `typeof window.yfe.call = ${String(bridge.call)}`);
  const bridged = Array.isArray(bridge.methods) ? bridge.methods : [];
  // 不写死数量：白名单是四份副本（channels / ipc-methods / preload.cjs / client-sdk），
  // 加一个 IPC 方法就会让「=6」这种断言过期；这里改成与权威 `IPC_METHODS` 逐项对齐。
  push(
    `preload.methods=${IPC_METHODS.length}`,
    bridged.length === IPC_METHODS.length && IPC_METHODS.every((method) => bridged.includes(method)),
    bridged.join(','),
  );
  push('vue.mounted', (raw?.dom?.appChildren ?? 0) > 0, `#app children=${raw?.dom?.appChildren}`);
  push('editor.mounted', raw?.dom?.editorPresent === true, raw?.dom?.editorPresent ? '.cm-editor 已挂载' : '未找到 .cm-editor');
  push('dom.hasText', (raw?.dom?.textLength ?? 0) > 0, String(raw?.dom?.text ?? '').slice(0, 80));
  push('csp.eval-blocked', raw?.csp?.evalBlocked === true, 'script-src 无 unsafe-eval，页面内 eval 必须失败');
  push('csp.connect-blocked', raw?.csp?.fetchBlocked === true, "connect-src 'none'，跨源 fetch 必须失败");

  const status = raw?.status;
  push('ipc.systemStatus', status?.ok === true, JSON.stringify(status ?? null).slice(0, 200));

  const project = raw?.project;
  const projectId = project?.ok === true ? pickId(project.value, 'project') : null;
  push('ipc.createProject', projectId !== null, JSON.stringify(project ?? null).slice(0, 200));

  const created = raw?.created;
  const documentId = created?.ok === true ? pickId(created.value, 'document') : null;
  push('ipc.createDocument', documentId !== null, JSON.stringify(created ?? null).slice(0, 200));

  push('ipc.saveDraft', raw?.saved?.ok === true, JSON.stringify(raw?.saved ?? null).slice(0, 200));

  const body = typeof raw?.body === 'string' ? raw.body : '';
  const readBack = raw?.loaded?.ok === true ? pickBody(raw.loaded.value, documentId ?? '') : null;
  push(
    'ipc.getDocument.正文往返',
    body.length > 0 && readBack === body,
    `写入=${JSON.stringify(body)} 读回=${JSON.stringify(readBack)}`,
  );

  return { ok: checks.every((c) => c.ok), checks };
}

async function runElectron(flags) {
  /** @type {any} */
  let electron;
  try {
    electron = await import('electron');
  } catch (thrown) {
    log('error', '无法加载 electron 模块；若要无 GUI 自检请加 --self-check', {
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    });
    return 1;
  }

  const { app, BrowserWindow, ipcMain, shell, dialog } = electron;

  // 沙箱例外必须在 app ready 之前决定（见 applySandboxOverride 的说明）。
  const sandboxDisabled = applySandboxOverride(app);

  /**
   * GUI 自检跑的是不是**全新 profile**。
   *
   * 决定要不要断言「首启必须显示欢迎向导」：`--db-path` 由调用方给定时，
   * profile 目录是按库路径哈希复用的，上一次跑可能已经写过「已看过」标记。
   */
  let guiProfileIsFresh = false;

  // GUI 自检独占 profile；不向用户正常数据库和作品记忆写入验收样本。
  if (flags.guiCheck) {
    guiProfileIsFresh = flags.dbPath === null;
    flags.dbPath ??= join(app.getPath('temp'), 'yfe-gui-check', randomUUID(), '正文.db');
    const profile = join(app.getPath('temp'), 'yfe-gui-check-profiles', createHash('sha256').update(resolve(flags.dbPath)).digest('hex'));
    mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  }

  // 🔴 单实例锁：设计文档 04 明确「单实例 SQLite 不能启动多个独立 writer 副本」。
  if (!app.requestSingleInstanceLock()) {
    log('warn', '已有实例在运行，本次启动退出');
    return 0;
  }

  const dbPath = resolveDbPath(flags.dbPath ?? join(app.getPath('userData'), 'data', DB_FILE_NAME));

  // 日志落盘（失败也不阻断启动）
  try {
    const logDir = join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'main.log');
    logSink = (line) => appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch {
    logSink = null;
  }
  log('info', '主进程启动', { appVersion: app.getVersion(), dbPath, electron: process.versions.electron });

  const host = createHost(dbPath);
  // AI 请求只在 main 发（渲染层 CSP connect-src 'none'）；见 src/main/ai-client.mjs。
  const aiClient = createAiClient();
  const rendererPath = join(HERE, '..', '..', 'dist', 'renderer', 'index.html');
  const devUrl = rendererDevUrl(process.env.YFE_RENDERER_URL, app.isPackaged);
  /** @type {any} */
  let mainWindow = null;
  let closeGuard = null;
  let pendingCloseFlush = null;

  ipcMain.on('yfe:close-result', (event, result) => {
    if (!isTrustedSender(event, mainWindow, rendererPath, devUrl)) return;
    if (pendingCloseFlush && result?.token === pendingCloseFlush.token) {
      pendingCloseFlush.resolve(result.saved === true);
    }
  });

  ipcMain.handle(IPC_CHANNEL, async (_event, request) => {
    const requestId = randomUUID();
    const method = request?.method;
    if (!isTrustedSender(_event, mainWindow, rendererPath, devUrl)) {
      return localFailureEnvelope(method, 'PERMISSION_DENIED', 'IPC 来源不受信任');
    }
    // 🔴 第二道白名单校验：renderer 被攻破时也不能调用白名单外的方法。
    if (typeof method !== 'string' || !IPC_METHODS.includes(method)) {
      log('warn', 'IPC 方法被拒', { requestId, method: String(method) });
      return localFailureEnvelope(method, 'PERMISSION_METHOD_NOT_ALLOWED', `IPC 方法不在白名单: ${String(method)}`);
    }
    const started = Date.now();
    // AI 方法在 main 本地处理（不进 DB worker）：模型请求需要网络，worker 是 SQLite 专用。
    if (method === 'aiComplete') {
      const result = await aiClient.complete(request?.payload ?? null);
      log('debug', 'IPC 完成', {
        requestId,
        method,
        ok: result.ok === true,
        ms: Date.now() - started,
        ...(result.ok === false ? { code: result.code } : {}),
      });
      return result.ok === true
        ? { kind: 'response', requestId, ok: true, method, value: result.value }
        : localFailureEnvelope(method, result.code, result.message);
    }
    const result = await host.call(method, request?.payload ?? null);
    log('debug', 'IPC 完成', {
      requestId: result?.ok === false ? result.error?.requestId : requestId,
      method,
      ok: result?.ok === true,
      ms: Date.now() - started,
      ...(result?.ok === false ? { code: result.error?.code } : {}),
    });
    return toEnvelope(method, result, requestId);
  });

  function createMainWindow() {
    try {
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#111318',
        title: '青春幻想引擎',
        webPreferences: {
          // 🔴 renderer 安全三元组，逐项显式写死，禁止依赖 Electron 默认值。
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          preload: PRELOAD_PATH,
        },
      });
      window.once('ready-to-show', () => {
        try {
          window.show();
        } catch (thrown) {
          log('warn', '窗口显示失败（可能无 GUI 会话）', { reason: String(thrown) });
        }
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        // 外链一律交给系统浏览器，绝不在应用内开新窗口。
        if (isExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!isRendererUrl(url, rendererPath, devUrl)) event.preventDefault();
      });
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.webContents.on('preload-error', (_event, _path, error) => {
        log('error', 'preload 加载失败', { reason: String(error) });
      });
      window.on('close', (event) => {
        if (flags.guiCheck || closeGuard?.allowed) return;
        event.preventDefault();
        void closeGuard?.request();
      });
      return window;
    } catch (thrown) {
      // 🔴 无 GUI 环境下创建窗口会抛错：记录并降级，绝不让它带崩整个进程。
      log('error', '创建窗口失败，本次以无窗口方式继续（不影响 worker 与 IPC 注册）', {
        reason: thrown instanceof Error ? thrown.message : String(thrown),
      });
      return null;
    }
  }

  try {
    await host.start();
    const opened = await host.open(dbPath);
    if (opened.ok) {
      log('info', '数据库就绪', { dbPath, schemaVersion: opened.value.schemaVersion });
    } else {
      log('error', '数据库打开失败', { dbPath, code: opened.error?.code, message: opened.error?.message });
    }
  } catch (thrown) {
    log('error', '服务启动失败，窗口仍会显示但功能不可用', {
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }

  // 🔴 必须等 app ready 再建窗口：Electron 在 ready 之前 `new BrowserWindow` 会直接抛
  //    「Cannot create BrowserWindow before app is ready」。原来这行缺失，导致窗口创建
  //    被 catch 吞成一条日志、GUI 永远起不来（而 GUI 路径此前从未被执行过）。
  await app.whenReady();

  let rendererLoading = Promise.resolve();
  mainWindow = createMainWindow();
  if (mainWindow) {
    closeGuard = createCloseGuard({
      flush: () => new Promise((resolve) => {
        const token = randomUUID();
        const timer = setTimeout(() => {
          pendingCloseFlush = null;
          resolve(false);
        }, REQUEST_TIMEOUT_MS);
        pendingCloseFlush = { token, resolve: (saved) => {
          clearTimeout(timer);
          pendingCloseFlush = null;
          resolve(saved);
        } };
        mainWindow.webContents.send('yfe:before-close', token);
      }),
      confirmDiscard: async () => {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: '草稿尚未保存',
          message: '部分正文尚未保存，或存在未解决的冲突。',
          detail: '选择继续编辑可以重试保存；放弃退出会丢弃尚未提交的改动。',
          buttons: ['继续编辑', '放弃并退出'], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1;
      },
      close: () => { if (!mainWindow.isDestroyed()) mainWindow.close(); },
    });
    const loading =
      devUrl === null
        ? mainWindow.loadFile(rendererPath)
        : mainWindow.loadURL(devUrl);
    rendererLoading = loading;
    loading.catch((thrown) => {
      log('warn', 'renderer 加载失败', { reason: String(thrown) });
    });
  }

  /** `--gui-check` 的收束：真窗口里跑完断言 → 打 JSON → 优雅关库 → 退出码。 */
  let guiCheckPromise = null;
  if (flags.guiCheck) {
    guiCheckPromise = (async () => {
      let timer;
      let checks;
      try {
        if (!mainWindow) throw new Error('窗口创建失败');
        const payload = await Promise.race([
          rendererLoading.then(() => collectGuiChecks(mainWindow)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('GUI 检查超时')), 35_000);
          }),
        ]);
        checks = payload.checks;
        /**
         * 编辑器阶段单独兜异常（R-52）。
         *
         * 原先两段共用一个 `try`，`collectEditorChecks` 抛错会把**已经跑出来的传输层断言
         * 整批丢掉**，只剩一行 `gui-check.failed` —— 2026-10-16 那次就是只看到
         * `界面正文未保存`、看不到 preload/CSP/IPC 那 8 项到底是过还是不过，
         * 排查时等于瞎猜。现在失败只追加一条，前面的结论和后面的「窗口可见」都保住。
         */
        try {
          checks.push(...await collectEditorChecks(mainWindow, { expectWelcome: guiProfileIsFresh }));
        } catch (thrown) {
          checks.push({
            name: 'ui.editor.failed',
            ok: false,
            detail: thrown instanceof Error ? thrown.message : String(thrown),
          });
        }
        const deadline = Date.now() + 3000;
        while (!mainWindow.isDestroyed() && !mainWindow.isVisible() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        checks.push({ name: 'window.visible', ok: !mainWindow.isDestroyed() && mainWindow.isVisible(), detail: '真窗口必须可见' });
      } catch (thrown) {
        checks = [{ name: 'gui-check.failed', ok: false, detail: thrown instanceof Error ? thrown.message : String(thrown) }];
      } finally {
        clearTimeout(timer);
      }
      const failedCount = checks.filter((check) => !check.ok).length;
      process.stdout.write(`${JSON.stringify({ ok: failedCount === 0, mode: 'gui-check', sandboxDisabled, dbPath, checks, failedCount }, null, 2)}\n`);
      await host.shutdown();
      return failedCount === 0 ? 0 : 1;
    })();
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  let quitReady = false;
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      if (!flags.guiCheck && mainWindow && !mainWindow.isDestroyed() && closeGuard &&
          !await closeGuard.request()) {
        quitting = false;
        return;
      }
      try {
        // 优雅停止：先中止在飞 AI 请求、拒绝新任务、等在途事务收尾，再关库（设计文档 04）。
        aiClient.abortAll();
        await host.shutdown();
      } catch (thrown) {
        log('error', '关闭服务时出错', { reason: String(thrown) });
      } finally {
        quitReady = true;
        app.quit();
      }
    })();
  });

  if (guiCheckPromise !== null) return await guiCheckPromise;

  // 🔴 正常桌面模式：**绝不返回、绝不 process.exit**。
  //    主进程必须活着，窗口才有意义（原来的 `return 0` + 入口的 `process.exit(0)`
  //    会让窗口刚建好就被杀掉——这也是 GUI 路径此前从没真正跑起来的原因之一）。
  log('info', '进入事件循环，等待用户关窗（关窗时经 before-quit 优雅关闭 worker）', { sandboxDisabled });
  return await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// 入口分派
// ---------------------------------------------------------------------------
const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(
    [
      '用法：',
      '  node src/main/main.mjs --self-check [--db-path=<file>]   无 GUI 自检（真起 worker 与数据库）',
      '  electron . [--gui-check] [--db-path=<file>]             桌面应用；--gui-check 在真窗口里跑断言后退出',
      '',
      '环境变量：',
      '  YFE_DATA_DIR           自检时数据库所在目录（默认 <cwd>/.yfe-data）',
      '  YFE_RENDERER_URL       开发模式渲染层地址（http://…，仅开发）',
      '  YFE_DISABLE_SANDBOX=1  本机验证用：关闭 Chromium 沙箱（宿主沙箱初始化失败时）',
      '',
    ].join('\n'),
  );
  process.exit(0);
} else if (flags.selfCheck) {
  const code = await runSelfCheck(resolveDbPath(flags.dbPath));
  process.exit(code);
} else {
  // Electron 会等待 ESM 入口求值结束才发出 ready；顶层 await whenReady 会互相等待。
  // 让入口先完成求值，异步启动由事件循环继续驱动。
  void runElectron(flags).then(async (code) => {
    process.exitCode = code;
    const { app } = await import('electron');
    if (code === 0) app.quit();
    else app.exit(code);
  }).catch((thrown) => {
    log('error', '桌面启动失败', { reason: thrown instanceof Error ? thrown.message : String(thrown) });
    process.exit(1);
  });
}
