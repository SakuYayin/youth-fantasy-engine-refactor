/**
 * DB worker 入口（普通 `.mjs`，**没有构建步骤**）。
 *
 * 进程职责（重构文档 `02-桌面与界面.md`）：数据库**只活在 worker 里**。
 * main 进程、renderer 与 preload 都不许直接开库，只能通过 service-host 发请求。
 *
 * 启动方式（两种都支持）：
 * - 纯 Node：`node apps/desktop/src/main/db-worker.mjs`
 * - Electron：`ELECTRON_RUN_AS_NODE=1 electron.exe apps/desktop/src/main/db-worker.mjs`
 *   （本机 Electron GUI 会崩 0xC0000005，验收一律走这两种，见 docs/adr/0001）
 *
 * 🔴 本文件的两条铁律：
 * 1. **先 `registerHooks` 再 `await import('@yfe/*')`**。包内相对导入写的是 `./x.js`
 *    而后缀实际是 `.ts`（源码直发、无构建），必须靠解析钩子把 `.js` 映射到 `.ts`。
 *    这也是本文件用**顶层 await 动态导入**而不是静态 import 的原因——静态 import
 *    会被提升到钩子注册之前。
 * 2. **异常绝不裸抛过进程边界**：一律用 `@yfe/contracts` 的 `Result` 形状回传，
 *    并且**剥掉 `cause`**（`toErrorPayload()` 的 `cause` 只允许本地调试，
 *    跨进程外发会泄漏 SQLite 驱动原文与文件路径）。
 */
import { registerHooks } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// 1) 解析钩子：./x.js → ./x.ts（必须在任何 @yfe 动态导入之前）
// ---------------------------------------------------------------------------
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (typeof specifier === 'string' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// 2) 通信通道：兼容 Electron utilityProcess 与 node:child_process fork
// ---------------------------------------------------------------------------
function createChannel() {
  const parentPort = process.parentPort;
  if (parentPort && typeof parentPort.postMessage === 'function') {
    return {
      kind: 'utilityProcess',
      send: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (event) => handler(event?.data)),
    };
  }
  return {
    kind: 'childProcess',
    send: (message) => {
      process.send?.(message);
    },
    onMessage: (handler) => process.on('message', handler),
  };
}

const channel = createChannel();

/** @param {string} level @param {string} message */
function diagnose(level, message) {
  channel.send({ kind: 'diagnostic', level, message });
}

// ---------------------------------------------------------------------------
// 3) 加载依赖包（钩子已就位）
// ---------------------------------------------------------------------------
/** @type {any} */
let persistence;
/** @type {any} */
let application;
try {
  persistence = await import('@yfe/persistence-sqlite');
  // 🔴 业务逻辑只来自用例层：worker 自己不实现任何一条业务规则，
  // 只负责「开库 → 装配端口 → 转发请求 → 回传 Result」。
  application = await import('@yfe/application');
  const contracts = await import('@yfe/contracts');
  globalThis.__yfeContracts = contracts;
} catch (thrown) {
  diagnose('error', `加载 @yfe 包失败：${thrown instanceof Error ? thrown.message : String(thrown)}`);
  // 没有依赖就不可能服务任何请求：明确以非零码退出，让监督器走重启/失败路径。
  process.exit(1);
}

const { ok, errOf, toErrorPayload, DB_SCHEMA_VERSION, systemClock } = globalThis.__yfeContracts;

const { openDatabase, closeDatabase, migrate, readSchemaVersion } = persistence;

const {
  createApplicationDeps,
  createApplicationIds,
  systemRevisionGenerator,
  saveDraft: saveDraftUseCase,
  createProject: createProjectUseCase,
  createDocument: createDocumentUseCase,
  getDocument: getDocumentUseCase,
  listDocumentTree: listDocumentTreeUseCase,
  systemStatus: systemStatusUseCase,
} = application;

// 组装点适配器（把 application 的端口接到 persistence 的具体驱动）：
// 它内部含静态的 `@yfe/*` 导入，所以必须等上面的解析钩子就位后再动态引入。
const { createSqliteApplicationPorts } = await import('./application-adapter.mjs');

// ---------------------------------------------------------------------------
// 4) worker 内部状态
// ---------------------------------------------------------------------------
/** @type {any} */
let db = null;
/** @type {string | null} */
let dbPath = null;
/** @type {any} */
let appDeps = null;
let shuttingDown = false;
let inFlight = 0;

/** 剥掉 `cause`：跨进程序列化时 `cause` 会泄漏驱动原文与绝对路径。 */
function safeErrorPayload(thrown, requestId) {
  const payload = toErrorPayload(thrown, requestId);
  const { cause: _cause, ...rest } = payload;
  return rest;
}

function respond(requestId, method, result) {
  if (result.ok) {
    channel.send({ kind: 'response', requestId, ok: true, method, value: result.value });
  } else {
    channel.send({ kind: 'response', requestId, ok: false, method, error: result.error });
  }
}

function requireApplication(requestId) {
  if (!db || !appDeps) {
    return errOf('STATE_INVALID_TRANSITION', '数据库尚未打开，请先调用 open', requestId);
  }
  return null;
}

/**
 * 装配用例依赖（`ApplicationDeps`）。
 *
 * **同一个** `ids` / `revisions` 必须既给用例层、又经适配器给 persistence：
 * 用例层的 `createProject`/`createDocument` 在调端口**之前**就生成了实体 ID 并直接返回
 * 给调用方（`application/src/ports.ts:87-90`），适配器正是靠这个共享的 `ids` 把
 * 「返回的 ID」与「落库的 ID」钉在一起（详见 `application-adapter.mjs` 文件头权宜之计 1）。
 */
function buildApplicationDeps() {
  const ids = createApplicationIds();
  const revisions = systemRevisionGenerator;
  const ports = createSqliteApplicationPorts({
    db,
    ids,
    revisions,
    // 运行时事实由持有连接的人（本文件）提供；库已关闭时回 null 让端口报 Err。
    describeDatabase: () => (db ? { path: dbPath ?? '', schemaVersion: readSchemaVersion(db) } : null),
  });
  return createApplicationDeps(ports, { clock: systemClock, ids, revisions });
}

// ---------------------------------------------------------------------------
// 5) 用例分派
// ---------------------------------------------------------------------------

/** 打开 + 迁移。幂等：同一路径重复调用只返回当前状态。 */
function handleOpen(payload, requestId) {
  const path = payload?.path;
  if (typeof path !== 'string' || path.length === 0) {
    return errOf('VALIDATION_FAILED', 'open 需要非空 path', requestId);
  }
  if (db && dbPath === path) {
    return ok({ path, schemaVersion: readSchemaVersion(db), reused: true });
  }
  if (db) {
    return errOf('STATE_INVALID_TRANSITION', '数据库已打开为另一个路径，请先关闭', requestId, { openPath: dbPath });
  }

  // 🔴 首次启动时工作区目录可能还不存在；better-sqlite3 不会自建父目录。
  // 由 worker 统一负责建目录，调用方（main / server / 测试）不必各自处理。
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (thrown) {
    return errOf('VALIDATION_FAILED', `无法创建数据库目录：${dirname(path)}`, requestId, {
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }

  const opened = openDatabase(path);
  try {
    const report = migrate(opened);
    db = opened;
    dbPath = path;
    appDeps = buildApplicationDeps();
    diagnose('info', `数据库已打开并迁移：path=${path} schemaVersion=${readSchemaVersion(opened)}`);
    return ok({
      path,
      schemaVersion: readSchemaVersion(opened),
      migrationVersion: report?.version ?? null,
      reused: false,
    });
  } catch (thrown) {
    // 🔴 迁移失败后绝不用这个连接写用户数据。
    try {
      closeDatabase(opened);
    } catch {
      // 忽略关闭失败：原始错误更重要
    }
    throw thrown;
  }
}

/**
 * 需要已打开数据库的方法的统一入口。
 *
 * 注意它只做「开库了吗」这一件事；业务规则一条都不在这里。
 */
function withApplication(requestId, run) {
  const missing = requireApplication(requestId);
  if (missing) return missing;
  return run(appDeps);
}

/**
 * 用例分派表：worker **只转发**，不实现业务。
 *
 * 🔴 铁律：端口/用例返回 `Err` 一律**原样上抛**给调用方。这里既不把失败改写成
 * 成功，也不吞掉 `NOT_FOUND_*` / `VERSION_CONFLICT` / `PERMISSION_*` ——
 * renderer 需要看到真实错误码才能给出正确的用户提示。
 *
 * `systemStatus` 的 payload 允许是 `null`（无读上下文）：用例只在 context
 * **为 undefined** 时跳过上下文校验，所以这里把 null 归一成 undefined，
 * 而不是把一个 null 上下文塞给校验器。
 */
const DISPATCH = {
  open: handleOpen,
  saveDraft: (payload, requestId) => withApplication(requestId, (deps) => saveDraftUseCase(deps, payload)),
  systemStatus: (payload, requestId) =>
    withApplication(requestId, (deps) => systemStatusUseCase(deps, payload ?? undefined)),
  listDocumentTree: (payload, requestId) =>
    withApplication(requestId, (deps) => listDocumentTreeUseCase(deps, payload)),
  getDocument: (payload, requestId) => withApplication(requestId, (deps) => getDocumentUseCase(deps, payload)),
  createProject: (payload, requestId) => withApplication(requestId, (deps) => createProjectUseCase(deps, payload)),
  createDocument: (payload, requestId) => withApplication(requestId, (deps) => createDocumentUseCase(deps, payload)),
};

// ---------------------------------------------------------------------------
// 6) 请求循环
// ---------------------------------------------------------------------------
async function handleRequest(message) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : 'unknown';
  const method = message?.method;
  inFlight += 1;
  try {
    if (shuttingDown) {
      respond(requestId, method, errOf('SERVICE_SHUTTING_DOWN', '数据库服务正在关闭，已拒绝新请求', requestId));
      return;
    }
    const handler = typeof method === 'string' ? DISPATCH[method] : undefined;
    if (typeof handler !== 'function') {
      respond(requestId, method, errOf('NOT_IMPLEMENTED', `未知的 worker 方法：${String(method)}`, requestId, { method: String(method) }));
      return;
    }
    const result = await handler(message.payload, requestId);
    respond(requestId, method, result);
  } catch (thrown) {
    // 任何未预期异常都在这里被拦下，绝不裸抛过进程边界。
    // 本地诊断保留完整信息（stderr 只在用户机器本地），跨进程载荷才做脱敏。
    diagnose(
      'error',
      `请求 ${method}（${requestId}）抛出异常：${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
    );
    respond(requestId, method, { ok: false, error: safeErrorPayload(thrown, requestId) });
  } finally {
    inFlight -= 1;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 优雅停止：① 拒绝新请求 ② 等在途请求结束（有上限）③ 关库 ④ 退出。 */
async function handleShutdown() {
  shuttingDown = true;
  const deadline = Date.now() + 5_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await delay(20);
  }
  try {
    if (db) {
      closeDatabase(db);
      diagnose('info', '数据库已关闭（worker 优雅停止）');
    }
  } catch (thrown) {
    diagnose('error', `关闭数据库失败：${thrown instanceof Error ? thrown.message : String(thrown)}`);
  } finally {
    db = null;
    appDeps = null;
    process.exit(0);
  }
}

channel.onMessage((message) => {
  if (message?.kind === 'shutdown') {
    void handleShutdown();
    return;
  }
  if (message?.kind === 'request') {
    void handleRequest(message);
  }
});

// 依赖与钩子都已就位，通知监督器可以接单。
channel.send({ kind: 'ready', channel: channel.kind, schemaVersion: DB_SCHEMA_VERSION });
diagnose('info', `db-worker 就绪（channel=${channel.kind}）`);
