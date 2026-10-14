/**
 * `./service-host.mjs` 的类型声明。
 *
 * 为什么单独写声明而不是开 allowJs：服务宿主的边界（Result 形状、统计字段、
 * 每个方法的可失败语义）是**跨进程契约**，值得被显式写下来并接受审查；
 * 靠 JS 推断出来的类型既不稳定也读不出意图。实现改动与本文件不一致时，
 * `npm run typecheck:tests` 会立刻报错。
 */

/** 用例失败信封：与 @yfe/contracts 的 ErrorPayload 同形。 */
export interface ServiceErrorPayload {
  code: string;
  message: string;
  requestId: string;
  severity: 'info' | 'warn' | 'error';
  retryable: boolean;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export type ServiceCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ServiceErrorPayload };

export interface ServiceDiagnosticEntry {
  level: string;
  message: string;
  at: string;
}

export interface ServiceHostOptions {
  /** worker 入口脚本的绝对路径 */
  workerPath: string;
  /** 可执行文件，默认 process.execPath（Electron 下需配合 ELECTRON_RUN_AS_NODE=1） */
  execPath?: string;
  execArgv?: string[];
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  maxRestarts?: number;
  restartCooldownMs?: number;
  onDiagnostic?: (entry: ServiceDiagnosticEntry) => void;
}

export interface ServiceHostStats {
  state: string;
  restarts: number;
  maxRestarts: number;
  pid: number | null;
  pending: number;
  diagnostics: number;
  requests: number;
  responses: number;
  timeouts: number;
  orphanResponses: number;
  workerExits: number;
  sendFailures: number;
}

export interface ServiceHost {
  /** 启动 worker 并等待 `{kind:'ready'}`（超时或提前退出会 reject）。 */
  start(): Promise<void>;
  /** 发一个用例调用；永远不会 reject，失败以 `{ok:false,error}` 返回。 */
  call(method: string, payload?: unknown): Promise<ServiceCallResult>;
  /** 打开数据库（等价于 `call('open', { path })`）。 */
  open(path: string): Promise<ServiceCallResult>;
  /** 优雅停止：拒绝新请求 → 等在途请求 → 停 worker。可重复调用。 */
  shutdown(): Promise<void>;
  /** 只在等待就绪时阻塞；已就绪立刻返回。 */
  waitForReady(timeoutMs?: number): Promise<void>;
  /** 立即强杀（测试/异常路径用）。 */
  forceKillWorker(): void;
  stats(): ServiceHostStats;
  diagnostics(): ServiceDiagnosticEntry[];
}

export declare function createServiceHost(options: ServiceHostOptions): ServiceHost;
