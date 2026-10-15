/**
 * Electron 主进程入口。
 *
 * 进程职责（重构文档 02 的进程职责表）：
 * - main：窗口、菜单、IPC 路由、生命周期。**不跑索引、不解析整库、不写 SQL、不发模型长请求。**
 * - db-worker（子进程）：数据库唯一的持有者，见 `./db-worker.mjs`。
 * - renderer：沙箱化，只能通过 preload 暴露的白名单方法调用 main。
 *
 * 🔴 本机 Electron GUI 会崩（0xC0000005，与本项目代码无关，见 docs/adr/0001）。
 *    因此本文件支持**无 GUI 自检**：`node src/main/main.mjs --self-check`
 *    会真起 worker、真开库、真跑一遍用例链并把 JSON 打到 stdout。
 *    这也是 task-8 验收要的「真实端到端输出」。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceHost } from './service-host.mjs';
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
  const flags = { selfCheck: false, dbPath: null, help: false };
  for (const arg of argv) {
    if (arg === '--self-check') flags.selfCheck = true;
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

  const { app, BrowserWindow, ipcMain, shell } = electron;

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
  /** @type {any} */
  let mainWindow = null;

  ipcMain.handle(IPC_CHANNEL, async (_event, request) => {
    const requestId = randomUUID();
    const method = request?.method;
    // 🔴 第二道白名单校验：renderer 被攻破时也不能调用白名单外的方法。
    if (typeof method !== 'string' || !IPC_METHODS.includes(method)) {
      log('warn', 'IPC 方法被拒', { requestId, method: String(method) });
      return localFailureEnvelope(method, 'PERMISSION_METHOD_NOT_ALLOWED', `IPC 方法不在白名单: ${String(method)}`);
    }
    const started = Date.now();
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
        void shell.openExternal(url).catch(() => undefined);
        return { action: 'deny' };
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

  /**
   * 开发模式的渲染层地址（`vite dev` 的 http 地址）。
   *
   * 生产绝不允许指向 http：`index.html` 的 CSP 与 `will-navigate` 白名单
   * 都假定产物来自本地文件。没配或配了空串就走构建产物。
   */
  function readRendererDevUrl() {
    const value = process.env.YFE_RENDERER_URL;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  let rendererOrigin = 'file://';
  mainWindow = createMainWindow();
  if (mainWindow) {
    const devUrl = readRendererDevUrl();
    if (devUrl !== null) {
      try {
        rendererOrigin = new URL(devUrl).origin;
      } catch {
        log('warn', 'YFE_RENDERER_URL 不是合法 URL，将按生产路径加载', { url: devUrl });
      }
    }
    const loading =
      devUrl === null
        ? mainWindow.loadFile(join(HERE, '..', '..', 'dist', 'renderer', 'index.html'))
        : mainWindow.loadURL(devUrl);
    loading.catch((thrown) => {
      log('warn', 'renderer 加载失败', { reason: String(thrown) });
    });
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('web-contents-created', (_event, contents) => {
    // 禁止渲染进程跳转到任意来源：只允许本地文件，以及开发模式显式配置的那个源。
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) return;
      if (rendererOrigin !== 'file://' && url.startsWith(rendererOrigin)) return;
      event.preventDefault();
      log('warn', '已阻止 renderer 导航', { url });
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        // 优雅停止：先拒绝新任务、等在途事务收尾，再关库（设计文档 04）。
        await host.shutdown();
      } catch (thrown) {
        log('error', '关闭服务时出错', { reason: String(thrown) });
      } finally {
        app.exit(0);
      }
    })();
  });

  return 0;
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
      '  electron .                                               正常启动桌面应用',
      '',
      '环境变量：',
      '  YFE_DATA_DIR  自检时数据库所在目录（默认 <cwd>/.yfe-data）',
      '',
    ].join('\n'),
  );
  process.exit(0);
} else if (flags.selfCheck) {
  const code = await runSelfCheck(resolveDbPath(flags.dbPath));
  process.exit(code);
} else {
  const code = await runElectron(flags);
  process.exit(code);
}
