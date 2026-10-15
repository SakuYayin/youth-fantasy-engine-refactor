/**
 * DB worker 监督器（service host）。
 *
 * 职责（重构文档 `02-桌面与界面.md` 进程职责表）：
 * - spawn DB worker 子进程（数据库只活在 worker 里，main 进程绝不直接开库）；
 * - 请求-响应关联（requestId）、单请求超时；
 * - worker 崩溃后**自动重启**，并把进行中的请求以 `SERVICE_RESTARTED` 结束
 *   （绝不永久挂起调用方）；
 * - 优雅停止：先拒绝新请求，再让 worker 关库退出。
 *
 * 🔴 本文件**刻意不 import 任何 `@yfe/*` 包**（只用 `node:child_process`）：
 *    Electron 主进程直接加载它，没有构建步骤；错误码用字面量，一致性由
 *    `tests/service-host.test.ts` 对照 `@yfe/contracts` 的 `ERROR_CODES` 锁定。
 *
 * 🔴 错误对象**不含 cause/堆栈**：`toErrorPayload()` 会带 `cause`（仅本地调试），
 *    跨进程/跨 IPC 边界必须剥掉，这里手工构造最小字段集。
 */
import { spawn } from 'node:child_process';

/** 单请求默认超时（毫秒）。超过即返回 NETWORK_TIMEOUT，不让调用方永久等待。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** worker 崩溃后最多自动重启几次；超过则进入 failed，后续调用返回 SERVICE_UNAVAILABLE。 */
export const DEFAULT_MAX_RESTARTS = 3;

/** 重启前的冷却时间，避免崩溃循环打满 CPU。 */
export const DEFAULT_RESTART_COOLDOWN_MS = 200;

/** 诊断日志环形缓冲上限，防止长跑期间无界增长。 */
export const MAX_DIAGNOSTICS = 200;

/** 本文件用到的契约错误码（测试会断言它们都真实存在于 ERROR_CODES）。 */
export const HOST_ERROR_CODES = Object.freeze({
  restarted: 'SERVICE_RESTARTED',
  shuttingDown: 'SERVICE_SHUTTING_DOWN',
  unavailable: 'SERVICE_UNAVAILABLE',
  timeout: 'NETWORK_TIMEOUT',
  internal: 'INTERNAL_ERROR',
});

const SEVERITY = Object.freeze({
  SERVICE_RESTARTED: 'error',
  SERVICE_SHUTTING_DOWN: 'error',
  SERVICE_UNAVAILABLE: 'error',
  NETWORK_TIMEOUT: 'warn',
  INTERNAL_ERROR: 'error',
});

const RETRYABLE = Object.freeze({
  SERVICE_RESTARTED: true,
  SERVICE_SHUTTING_DOWN: true,
  SERVICE_UNAVAILABLE: true,
  NETWORK_TIMEOUT: true,
  INTERNAL_ERROR: false,
});

/**
 * 构造最小错误载荷：显式不含 `cause`，避免把 SQLite 驱动原文或文件路径泄漏出去。
 * @param {string} code
 * @param {string} message
 * @param {string} requestId
 * @returns {{code: string, message: string, requestId: string, severity: string, retryable: boolean}}
 */
function failure(code, message, requestId) {
  return {
    code,
    message,
    requestId,
    severity: SEVERITY[code] ?? 'error',
    retryable: RETRYABLE[code] ?? false,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 让进程能正常退出，不被这个定时器拖住
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 创建一个 DB worker 监督器。
 *
 * @param {object} options
 * @param {string} options.workerPath DB worker 入口脚本绝对路径
 * @param {string} [options.execPath] 运行 worker 的可执行文件（默认 process.execPath）
 * @param {string[]} [options.execArgv] 附加给可执行文件的参数
 * @param {Record<string, string | undefined>} [options.env]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxRestarts]
 * @param {number} [options.restartCooldownMs]
 * @param {(entry: {level: string, message: string, at: string}) => void} [options.onDiagnostic]
 */
export function createServiceHost(options) {
  const {
    workerPath,
    execPath = process.execPath,
    execArgv = [],
    env = process.env,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    restartCooldownMs = DEFAULT_RESTART_COOLDOWN_MS,
    onDiagnostic,
  } = options ?? {};

  if (typeof workerPath !== 'string' || workerPath.length === 0) {
    throw new Error('createServiceHost 需要 workerPath');
  }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {Map<string, {resolve: (value: unknown) => void, timer: NodeJS.Timeout, method: string}>} */
  const pending = new Map();
  /**
   * 等待 worker 就绪的调用方集合。
   * 🔴 必须是**列表**而不是单槽：启动瞬间可能有多个请求同时在等 ready
   *    （例如 UI 一上来并发拉 systemStatus + 文档树）。单槽会让后到的把先到的
   *    覆盖掉，被覆盖的请求只能干等到自身超时——表现为「首批并发请求莫名失败」。
   * @type {Array<{resolve: () => void, reject: (reason: Error) => void, timer: NodeJS.Timeout}>}
   */
  let readyWaiters = [];
  let closed = false;
  let restarts = 0;
  let seq = 0;
  /** @type {'idle' | 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed'} */
  let state = 'idle';
  let openedPath = null;
  /** @type {Array<{level: string, message: string, at: string}>} */
  const diagnostics = [];
  const counters = { requests: 0, responses: 0, timeouts: 0, orphanResponses: 0, workerExits: 0, sendFailures: 0 };

  function record(level, message) {
    const entry = { level, message, at: new Date().toISOString() };
    diagnostics.push(entry);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
    if (typeof onDiagnostic === 'function') {
      try {
        onDiagnostic(entry);
      } catch {
        // 诊断回调自身抛错不得影响监督器
      }
    }
  }

  function rejectAllPending(code, message) {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: failure(code, message, requestId) });
    }
    pending.clear();
  }

  /** 唤醒（或统一拒绝）当前所有在等就绪的调用方。 */
  function settleReady(error) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function handleMessage(raw) {
    const msg = raw;
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'ready') {
      record('info', 'worker 就绪');
      if (openedPath === null) {
        state = 'ready';
        settleReady(null);
      } else {
        // 重启后的进程没有数据库连接；恢复原库成功后才放行排队请求。
        state = 'starting';
        const initializingChild = child;
        void sendRequest('open', { path: openedPath }).then((result) => {
          if (child !== initializingChild || closed) return;
          if (result.ok) {
            state = 'ready';
            settleReady(null);
          } else {
            state = 'failed';
            settleReady(new Error('重启后无法重新打开数据库'));
          }
        });
      }
      return;
    }

    if (msg.kind === 'diagnostic' && typeof msg.message === 'string') {
      record(typeof msg.level === 'string' ? msg.level : 'info', msg.message);
      return;
    }

    if (msg.kind === 'response' && typeof msg.requestId === 'string') {
      const entry = pending.get(msg.requestId);
      if (!entry) {
        counters.orphanResponses += 1;
        record('warn', `收到无主响应 requestId=${msg.requestId}（可能是超时后迟到）`);
        return;
      }
      pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      counters.responses += 1;
      if (msg.ok === true) entry.resolve({ ok: true, value: msg.value });
      else entry.resolve({ ok: false, error: msg.error });
    }
  }

  function handleExit(code, signal) {
    child = null;
    counters.workerExits += 1;
    // 就绪前退出：所有等待者一起失败，绝不让任何一个永久挂起。
    settleReady(new Error(`DB worker 在就绪前退出：code=${String(code)} signal=${String(signal)}`));

    // 🔴 关键：崩溃时进行中的请求必须被显式结束，否则调用方永久挂起。
    rejectAllPending(HOST_ERROR_CODES.restarted, '服务进程意外退出，本次请求已中止，请重试');

    if (closed) {
      state = 'stopped';
      record('info', `worker 已退出（code=${String(code)}），监督器已关闭，不再重启`);
      return;
    }

    if (restarts < maxRestarts) {
      restarts += 1;
      state = 'restarting';
      record('warn', `worker 退出（code=${String(code)} signal=${String(signal)}），第 ${restarts}/${maxRestarts} 次重启`);
      setTimeout(() => {
        if (!closed) start();
      }, restartCooldownMs).unref?.();
      return;
    }

    state = 'failed';
    record('error', `worker 连续退出 ${restarts} 次，已放弃自动重启`);
  }

  function start() {
    if (child || closed) return null;
    state = 'starting';
    const spawned = spawn(execPath, [...execArgv, workerPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
      windowsHide: true,
    });
    child = spawned;

    spawned.on('message', handleMessage);
    spawned.on('error', (error) => {
      record('error', `worker 启动失败：${error.message}`);
      rejectAllPending(HOST_ERROR_CODES.unavailable, '服务进程无法启动');
      state = 'failed';
      if (child === spawned) child = null;
      settleReady(error);
    });
    spawned.on('exit', handleExit);
    spawned.stdout?.on('data', (chunk) => record('debug', String(chunk).trimEnd()));
    spawned.stderr?.on('data', (chunk) => record('error', String(chunk).trimEnd()));
    record('info', `worker 已启动 pid=${String(spawned.pid)}`);
    return spawned;
  }

  /** 等待 worker 发送 ready；已就绪时立即返回。支持任意多个并发等待者。 */
  function waitForReady(timeoutMs = requestTimeoutMs) {
    if (state === 'ready' && child) return Promise.resolve();
    if (closed) return Promise.reject(new Error('监督器已关闭'));
    if (state === 'failed') return Promise.reject(new Error('worker 已进入 failed 状态'));
    return new Promise((resolve, reject) => {
      /** @type {{resolve: () => void, reject: (reason: Error) => void, timer: NodeJS.Timeout}} */
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        reject: (reason) => {
          clearTimeout(waiter.timer);
          reject(reason);
        },
        timer: /** @type {any} */ (null),
      };
      waiter.timer = setTimeout(() => {
        // 只摘掉自己这一项，别人的等待不受影响
        const index = readyWaiters.indexOf(waiter);
        if (index >= 0) readyWaiters.splice(index, 1);
        reject(new Error('等待 DB worker 就绪超时'));
      }, timeoutMs);
      readyWaiters.push(waiter);
    });
  }

  /**
   * 发起一次调用。任何失败路径都返回 `Result`（`{ok:false,error}`），**绝不抛异常、绝不挂起**。
   * @param {string} method
   * @param {unknown} payload
   * @param {{timeoutMs?: number}} [callOptions]
   * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: unknown}>}
   */
  async function call(method, payload, callOptions) {
    const requestId = `req_${++seq}`;

    if (closed) {
      return { ok: false, error: failure(HOST_ERROR_CODES.shuttingDown, '服务正在关闭，已拒绝新请求', requestId) };
    }
    if (state === 'failed') {
      return { ok: false, error: failure(HOST_ERROR_CODES.unavailable, '服务不可用（worker 已放弃重启）', requestId) };
    }
    if (!child) start();
    if (!child) {
      return { ok: false, error: failure(HOST_ERROR_CODES.unavailable, '服务正在启动', requestId) };
    }

    try {
      await waitForReady(callOptions?.timeoutMs ?? requestTimeoutMs);
    } catch (error) {
      return {
        ok: false,
        error: failure(HOST_ERROR_CODES.unavailable, `服务未就绪：${/** @type {Error} */ (error).message}`, requestId),
      };
    }

    if (closed) {
      return { ok: false, error: failure(HOST_ERROR_CODES.shuttingDown, '服务正在关闭', requestId) };
    }
    const result = await sendRequest(method, payload, callOptions, requestId);
    if (method === 'open' && result.ok && typeof payload?.path === 'string') openedPath = payload.path;
    return result;
  }

  function sendRequest(method, payload, callOptions, requestId = `req_${++seq}`) {
    const target = child;
    if (!target) {
      return { ok: false, error: failure(HOST_ERROR_CODES.unavailable, '服务进程已退出', requestId) };
    }

    counters.requests += 1;
    const timeoutMs = callOptions?.timeoutMs ?? requestTimeoutMs;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        counters.timeouts += 1;
        record('warn', `请求超时 method=${method} requestId=${requestId}（${timeoutMs}ms）`);
        resolve({ ok: false, error: failure(HOST_ERROR_CODES.timeout, `请求超时（${timeoutMs}ms）`, requestId) });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      pending.set(requestId, { resolve, timer, method });

      try {
        // send(false) 只是背压，消息仍已排队；只在回调报错时判定发送失败。
        target.send({ kind: 'request', requestId, method, payload }, (error) => {
          if (!error || !pending.has(requestId)) return;
          counters.sendFailures += 1;
          pending.delete(requestId);
          clearTimeout(timer);
          resolve({ ok: false, error: failure(HOST_ERROR_CODES.restarted, '发送请求失败', requestId) });
        });
      } catch (error) {
        counters.sendFailures += 1;
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({
          ok: false,
          error: failure(HOST_ERROR_CODES.restarted, `发送请求失败：${/** @type {Error} */ (error).message}`, requestId),
        });
      }
    });
  }

  /** 打开数据库（worker 内部执行 openDatabase + migrate）。 */
  function open(dbPath) {
    return call('open', { path: dbPath });
  }

  /**
   * 优雅停止：拒绝新请求 → 等在途请求结束（有上限）→ 让 worker 关库退出 → 必要时强杀。
   * @param {{timeoutMs?: number}} [stopOptions]
   */
  async function shutdown(stopOptions) {
    if (closed) return;
    closed = true;
    settleReady(new Error('监督器已关闭'));
    const timeoutMs = stopOptions?.timeoutMs ?? 5_000;

    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      await delay(20);
    }
    rejectAllPending(HOST_ERROR_CODES.shuttingDown, '服务关闭，请求已被取消');

    const target = child;
    if (!target) {
      state = 'stopped';
      return;
    }

    const exitedPromise = new Promise((resolve) => target.once('exit', () => resolve(true)));
    try {
      target.send({ kind: 'shutdown' });
    } catch {
      // 通道已断，直接走强杀
    }

    const settled = await Promise.race([exitedPromise, delay(timeoutMs).then(() => false)]);
    if (!settled) {
      record('warn', 'worker 未在期限内退出，强制结束');
      try {
        target.kill();
      } catch {
        // 已经退出
      }
      await Promise.race([exitedPromise, delay(1_000)]);
    }
    state = 'stopped';
  }

  /** 🔴 仅测试与紧急恢复使用：强杀当前 worker，验证崩溃重启路径。 */
  function forceKillWorker() {
    const target = child;
    if (!target) return false;
    try {
      target.kill();
      return true;
    } catch {
      return false;
    }
  }

  function stats() {
    return {
      state,
      restarts,
      maxRestarts,
      pid: child?.pid ?? null,
      pending: pending.size,
      diagnostics: diagnostics.length,
      ...counters,
    };
  }

  return {
    start,
    call,
    open,
    shutdown,
    waitForReady,
    forceKillWorker,
    stats,
    diagnostics: () => diagnostics.slice(),
  };
}
