/**
 * 草稿会话状态机。
 *
 * 落地设计文档 `重构相关文档/重构开发文档/02-桌面与界面.md`「编辑器」一节的硬性要求：
 *
 * 1. 「正文不以双向绑定的大字符串在每个键入时整段重建」——本模块只持有当前正文与**草稿序号**，
 *    由调用方（编辑器适配器）在编辑事务落定后调用 `onInput`，不参与任何渲染。
 * 2. 「采用编辑事务与草稿序号，防抖保存并设置最长等待」——`debounceMs` 合并连续键入，
 *    `maxWaitMs` 保证持续键入时也不会无限推迟。
 * 3. 「切章、切作品和退出前冲刷」——`flush()` 立即派发并等待目标序号拿到一次结果。
 * 4. 「保存结果只确认对应草稿序号，迟到结果不得覆盖新稿」——`settle` 只接受与在途序号相等的结果；
 *    序号不大于已结算序号的结果一律丢弃，不会推进 `revision`，也不会把新正文标记为已保存。
 * 5. 「外部更新当前章时：没有本地未提交编辑可安全刷新；存在草稿则保留编辑器状态并提示外部版本，
 *    进入冲突处理」——`applyExternalUpdate` 返回 `'applied'` 或 `'conflict'`。
 * 6. 「输入法组合态不被远程事件重置」——本模块不在编辑过程中改写正文；外部更新在有草稿时
 *    只记录冲突快照，正文一字不动。
 *
 * 本模块不依赖 Electron、Vue 或 CodeMirror，可无头验收。保存本身由注入的 `save` 完成
 * （生产环境接 `window.yfe.call('saveDraft', …)`），因此状态机可以在没有服务端的情况下被完整测试。
 *
 * 边界（刻意不做的部分）：
 * - 不实现同步状态（本地已保存/待同步/同步中/冲突/连接失败）——那是同步协议层，与本机保存正交。
 * - 不实现重试退避；失败后由 UI 决定重新输入或调用 `retry()`。
 * - 不实现冲突合并算法（三分支合并属于领域层），只做「保留哪一份」的裁决。
 */

/** 本机保存状态。注意与同步状态是两个正交维度，网络错误不得改写它。 */
export type LocalSaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

/** 一次保存请求。`expectedRevision` 是乐观锁基线，由服务端裁决。 */
export interface DraftSaveRequest {
  readonly documentId: string;
  readonly sessionId: string;
  /** 单调递增的草稿序号，从 1 开始。 */
  readonly draftSequence: number;
  readonly body: string;
  readonly expectedRevision: string;
}

/** 保存结果。`draftSequence` 必须原样回带，状态机据此确认或丢弃。 */
export interface DraftSaveOutcome {
  readonly ok: boolean;
  readonly draftSequence: number;
  /** 成功时的服务端新版本号；失败时忽略。 */
  readonly revision?: string;
  /** 失败时的契约错误码。 */
  readonly code?: string;
}

/** 未解决的外部更新（冲突）快照。 */
export interface DraftConflict {
  readonly externalRevision: string;
  readonly externalBody: string;
}

/** 对外只读快照，每次状态变化后通过 `onStateChange` 推送。 */
export interface DraftSessionSnapshot {
  readonly documentId: string;
  readonly sessionId: string;
  readonly status: LocalSaveStatus;
  readonly body: string;
  readonly revision: string;
  readonly draftSequence: number;
  /** 在途保存的草稿序号；无在途为 null。 */
  readonly inFlightSequence: number | null;
  readonly lastConfirmedSequence: number;
  readonly hasUnsavedChanges: boolean;
  readonly conflict: DraftConflict | null;
  readonly lastErrorCode: string | null;
  /** 被丢弃的迟到/重复结果计数，用于诊断「迟到回包」是否真的出现过。 */
  readonly ignoredResults: number;
  readonly saveAttempts: number;
}

export interface DraftSessionDeps {
  readonly save: (request: DraftSaveRequest) => Promise<DraftSaveOutcome>;
  readonly onStateChange?: (snapshot: DraftSessionSnapshot) => void;
  /** 防抖窗口，默认 800 ms。 */
  readonly debounceMs?: number;
  /** 最长等待：从出现未保存改动起算，超过即强制派发。默认 5000 ms。 */
  readonly maxWaitMs?: number;
  /** 可注入时钟，测试用假定时器时无需替换。 */
  readonly now?: () => number;
  readonly onDiagnostic?: (level: 'info' | 'warn', message: string) => void;
}

export interface DraftSessionInit {
  readonly documentId: string;
  readonly sessionId: string;
  readonly body: string;
  readonly revision: string;
}

export const DEFAULT_DEBOUNCE_MS = 800;
export const DEFAULT_MAX_WAIT_MS = 5000;

/** 冲突裁决：保留本地正文并重挂到外部版本，或放弃本地草稿采用外部正文。 */
export type ConflictResolution = 'keep-local' | 'take-external';

export class DraftSession {
  private readonly documentId: string;
  private readonly sessionId: string;
  private readonly deps: DraftSessionDeps;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  private body: string;
  private confirmedBody: string;
  private revision: string;

  private draftSequence = 0;
  private lastConfirmedSequence = 0;
  private lastSettledSequence = 0;

  private inFlight: { readonly sequence: number; readonly body: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince: number | null = null;

  private conflict: DraftConflict | null = null;
  private lastErrorCode: string | null = null;

  private ignoredResults = 0;
  private saveAttempts = 0;
  private disposed = false;

  private flushWaiters: Array<{ readonly target: number; readonly resolve: (outcome: DraftSaveOutcome | null) => void }> = [];

  constructor(init: DraftSessionInit, deps: DraftSessionDeps) {
    this.documentId = init.documentId;
    this.sessionId = init.sessionId;
    this.body = init.body;
    this.confirmedBody = init.body;
    this.revision = init.revision;
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 编辑器在编辑事务落定后调用。相同正文不产生新草稿序号。 */
  onInput(body: string): void {
    if (this.disposed) return;
    if (body === this.body) return;

    this.body = body;
    this.draftSequence += 1;

    if (!this.hasUnsavedChanges) {
      // 改回已确认的内容：无需保存，取消已排期的派发。
      this.cancelTimer();
      this.pendingSince = null;
      this.lastErrorCode = null;
      this.refresh();
      return;
    }

    this.scheduleSave();
  }

  /**
   * 立即派发当前草稿并等待「调用时刻的草稿序号」拿到一次结果。
   * 切章、切作品、关闭窗口前调用。无未保存改动时同步 resolve `null`。
   */
  flush(): Promise<DraftSaveOutcome | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.conflict !== null) return Promise.resolve(null);

    this.cancelTimer();
    const target = this.draftSequence;

    if (!this.hasUnsavedChanges && this.inFlight === null) return Promise.resolve(null);

    this.dispatch();
    if (this.inFlight === null && !this.hasUnsavedChanges) return Promise.resolve(null);

    return new Promise<DraftSaveOutcome | null>((resolve) => {
      this.flushWaiters.push({ target, resolve });
    });
  }

  /** 失败后手动重试（不等防抖窗口）。 */
  retry(): void {
    if (this.disposed) return;
    if (this.conflict !== null) return;
    if (!this.hasUnsavedChanges) return;
    this.cancelTimer();
    this.ensurePendingSince();
    this.dispatch();
  }

  /**
   * 外部（同步/插件/AI 建议稿被采用）更新当前章。
   * 无本地未保存改动时安全刷新并返回 `'applied'`；否则只记录冲突并返回 `'conflict'`，正文不动。
   */
  applyExternalUpdate(update: { readonly revision: string; readonly body: string }): 'applied' | 'conflict' {
    if (this.disposed) return 'conflict';

    if (this.conflict !== null || this.hasUnsavedChanges || this.inFlight !== null) {
      this.conflict = { externalRevision: update.revision, externalBody: update.body };
      this.cancelTimer();
      this.refresh();
      return 'conflict';
    }

    this.revision = update.revision;
    this.body = update.body;
    this.confirmedBody = update.body;
    this.lastErrorCode = null;
    this.refresh();
    return 'applied';
  }

  /**
   * 裁决冲突。
   * - `'take-external'`：放弃本地草稿，采用外部正文与版本；在途保存的结果会被判为过期而丢弃。
   * - `'keep-local'`：保留本地正文，把乐观锁基线改挂到外部版本后立即重新保存。
   */
  resolveConflict(resolution: ConflictResolution): void {
    if (this.disposed) return;
    const pending = this.conflict;
    if (pending === null) return;

    this.conflict = null;
    this.lastErrorCode = null;

    if (resolution === 'take-external') {
      this.cancelTimer();
      // 在途保存基于旧版本与本地正文，其结果不得再被确认。
      this.lastSettledSequence = Math.max(this.lastSettledSequence, this.draftSequence);
      this.inFlight = null;
      this.body = pending.externalBody;
      this.confirmedBody = pending.externalBody;
      this.revision = pending.externalRevision;
      this.draftSequence += 1;
      this.lastConfirmedSequence = this.draftSequence;
      this.pendingSince = null;
      this.refresh();
      return;
    }

    this.revision = pending.externalRevision;
    this.ensurePendingSince();
    this.dispatch();
  }

  /** 关闭会话：取消定时器，未决的 `flush` 以 `null` 收束。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.inFlight = null;
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const waiter of waiters) waiter.resolve(null);
  }

  getSnapshot(): DraftSessionSnapshot {
    return {
      documentId: this.documentId,
      sessionId: this.sessionId,
      status: this.deriveStatus(),
      body: this.body,
      revision: this.revision,
      draftSequence: this.draftSequence,
      inFlightSequence: this.inFlight?.sequence ?? null,
      lastConfirmedSequence: this.lastConfirmedSequence,
      hasUnsavedChanges: this.hasUnsavedChanges,
      conflict: this.conflict,
      lastErrorCode: this.lastErrorCode,
      ignoredResults: this.ignoredResults,
      saveAttempts: this.saveAttempts,
    };
  }

  get hasUnsavedChanges(): boolean {
    return this.body !== this.confirmedBody;
  }

  private deriveStatus(): LocalSaveStatus {
    if (this.inFlight !== null) return 'saving';
    if (!this.hasUnsavedChanges) return 'saved';
    if (this.lastErrorCode !== null) return 'error';
    return 'dirty';
  }

  /** 返回「本轮未保存改动」的起点时刻；返回值直接用作最长等待的基准，避免 null 收窄丢失。 */
  private ensurePendingSince(): number {
    if (this.pendingSince === null) this.pendingSince = this.now();
    return this.pendingSince;
  }

  private scheduleSave(): void {
    if (this.disposed || !this.hasUnsavedChanges) return;
    const since = this.ensurePendingSince();

    // 在途保存未回来前不再派发第二个请求；但保留「有新改动」这一事实，结算后立刻续派。
    if (this.inFlight !== null) {
      this.refresh();
      return;
    }

    this.cancelTimer();
    const elapsed = this.now() - since;
    // 剩余窗口 = min(防抖窗口, 最长等待的余额)，因此持续键入也必然在 maxWaitMs 内落一次。
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - elapsed));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch();
    }, wait);
    this.refresh();
  }

  private dispatch(): void {
    if (this.disposed) return;
    if (this.inFlight !== null) return;
    if (this.conflict !== null) return;
    if (!this.hasUnsavedChanges) {
      this.pendingSince = null;
      this.refresh();
      return;
    }

    const request: DraftSaveRequest = {
      documentId: this.documentId,
      sessionId: this.sessionId,
      draftSequence: this.draftSequence,
      body: this.body,
      expectedRevision: this.revision,
    };

    this.inFlight = { sequence: request.draftSequence, body: request.body };
    this.pendingSince = null;
    this.lastErrorCode = null;
    this.saveAttempts += 1;
    this.refresh();

    void Promise.resolve()
      .then(() => this.deps.save(request))
      .then(
        (outcome: unknown) => {
          const normalized = coerceOutcome(outcome, request.draftSequence);
          if (normalized.code === 'SAVE_RESULT_MALFORMED') {
            this.diagnose('warn', '适配器返回了无法识别的保存结果，按一次失败结算');
          }
          this.settle(normalized);
        },
        (error: unknown) => {
          // 适配器抛错等同于一次失败结果；正文与序号原地保留，绝不丢字。
          this.settle({
            ok: false,
            draftSequence: request.draftSequence,
            code: error instanceof Error ? 'SAVE_ADAPTER_THREW' : 'SAVE_ADAPTER_FAILED',
          });
        },
      );
  }

  private settle(outcome: DraftSaveOutcome): void {
    if (this.disposed) return;

    const flight = this.inFlight;
    if (flight === null) {
      this.ignoredResults += 1;
      this.diagnose('warn', `收到无在途保存的结果（序号 ${outcome.draftSequence}），已丢弃`);
      this.refresh();
      return;
    }

    // 迟到结果：它属于比当前在途更早的一次保存（例如 take-external 之后又开始了新保存），
    // 不得推进 revision，也不得把新正文标记为已保存。
    //
    // 判据必须是「比在途更早」，**不能**是「≤ 已结算序号」：失败结算同样会推进
    // lastSettledSequence，而失败后 retry 用的还是同一个草稿序号——按已结算判定会把重试的
    // 成功结果当成迟到结果丢掉，inFlight 再也清不掉，会话永久卡在 saving，
    // 用户此后敲什么都存不进去（回归用例：draft-session.test.ts 的 retry 用同一序号）。
    if (outcome.draftSequence < flight.sequence) {
      this.ignoredResults += 1;
      this.diagnose('warn', `丢弃迟到结果（序号 ${outcome.draftSequence} < 在途 ${flight.sequence}）`);
      this.refresh();
      return;
    }

    if (outcome.draftSequence !== flight.sequence) {
      // 适配器回带了非本次在途的序号：视为协议违例，本次以失败结算但确认正文不变。
      this.inFlight = null;
      this.lastSettledSequence = Math.max(this.lastSettledSequence, flight.sequence);
      this.lastErrorCode = 'SAVE_RESULT_SEQUENCE_MISMATCH';
      this.diagnose('warn', `结果序号 ${outcome.draftSequence} 与在途 ${flight.sequence} 不符`);
      this.afterSettle(flight.sequence, null);
      return;
    }

    this.inFlight = null;
    this.lastSettledSequence = Math.max(this.lastSettledSequence, flight.sequence);

    if (outcome.ok) {
      // 只确认这次请求真正提交的正文；此后到达的新键入仍然是未保存状态。
      this.confirmedBody = flight.body;
      this.lastConfirmedSequence = Math.max(this.lastConfirmedSequence, flight.sequence);
      if (typeof outcome.revision === 'string' && outcome.revision.length > 0) this.revision = outcome.revision;
      this.lastErrorCode = null;
    } else {
      this.lastErrorCode = outcome.code ?? 'SAVE_FAILED';
    }

    this.afterSettle(flight.sequence, outcome);
  }

  private afterSettle(sequence: number, outcome: DraftSaveOutcome | null): void {
    const settled = this.flushWaiters;
    this.flushWaiters = settled.filter((waiter) => waiter.target > sequence);
    for (const waiter of settled) {
      if (waiter.target <= sequence) waiter.resolve(outcome);
    }

    // 只有「本次确实保存成功」才立刻续派在途期间到达的新改动。
    // 失败（或协议违例 outcome===null）时必须停在 error 态等用户 retry 或下一次键入，
    // 否则会在失败后自动重派形成无限重试，状态永远显示 saving。
    if (outcome !== null && outcome.ok && this.hasUnsavedChanges && this.conflict === null) {
      this.ensurePendingSince();
      this.dispatch();
    }
    this.refresh();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private refresh(): void {
    if (this.deps.onStateChange === undefined) return;
    this.deps.onStateChange(this.getSnapshot());
  }

  private diagnose(level: 'info' | 'warn', message: string): void {
    this.deps.onDiagnostic?.(level, message);
  }
}

/**
 * 适配器返回值的形状校验。
 *
 * 适配器跨 IPC / 跨版本边界，可能返回 undefined、字符串或缺字段的对象。若不校验，
 * `outcome.draftSequence` 会在 promise 链里抛 TypeError 变成 unhandled rejection，
 * 且 `inFlight` 永远不会被清空 → 会话永久卡在 saving，用户此后无法再保存。
 * 因此一切无法识别的形状都折算成一次带明确错误码的失败结算。
 */
function coerceOutcome(value: unknown, fallbackSequence: number): DraftSaveOutcome {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { draftSequence?: unknown; ok?: unknown };
    if (
      typeof candidate.draftSequence === 'number' &&
      Number.isFinite(candidate.draftSequence) &&
      typeof candidate.ok === 'boolean'
    ) {
      return value as DraftSaveOutcome;
    }
  }
  return { ok: false, draftSequence: fallbackSequence, code: 'SAVE_RESULT_MALFORMED' };
}

export function createDraftSession(init: DraftSessionInit, deps: DraftSessionDeps): DraftSession {
  return new DraftSession(init, deps);
}
