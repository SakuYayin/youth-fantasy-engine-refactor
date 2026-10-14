import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  type DraftSaveOutcome,
  type DraftSaveRequest,
  type DraftSessionSnapshot,
  createDraftSession,
} from '../src/renderer/state/draft-session.js';

interface PendingSave {
  readonly request: DraftSaveRequest;
  readonly resolve: (outcome: DraftSaveOutcome) => void;
  readonly reject: (error: unknown) => void;
}

interface Harness {
  readonly requests: DraftSaveRequest[];
  readonly pending: PendingSave[];
  readonly snapshots: DraftSessionSnapshot[];
  readonly session: ReturnType<typeof createDraftSession>;
  /** 结算第 index 次保存请求。 */
  settle: (index: number, outcome: Partial<DraftSaveOutcome> & { ok: boolean }) => Promise<void>;
  rejectAt: (index: number, error: unknown) => Promise<void>;
  /** 投递畸形/未知形状的返回值，验证形状校验。 */
  resolveRaw: (index: number, value: unknown) => Promise<void>;
  type: (body: string) => void;
}

function createHarness(options: {
  body?: string;
  revision?: string;
  debounceMs?: number;
  maxWaitMs?: number;
} = {}): Harness {
  const requests: DraftSaveRequest[] = [];
  const pending: PendingSave[] = [];
  const snapshots: DraftSessionSnapshot[] = [];

  const session = createDraftSession(
    {
      documentId: 'doc-1',
      sessionId: 'session-1',
      body: options.body ?? '',
      revision: options.revision ?? 'rev-0',
    },
    {
      save: (request) =>
        new Promise<DraftSaveOutcome>((resolve, reject) => {
          requests.push(request);
          pending.push({ request, resolve, reject });
        }),
      onStateChange: (snapshot) => snapshots.push(snapshot),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    },
  );

  async function settle(
    index: number,
    outcome: Partial<DraftSaveOutcome> & { ok: boolean },
  ): Promise<void> {
    const entry = pending[index];
    if (entry === undefined) throw new Error(`没有第 ${index} 个在途保存`);
    entry.resolve({ draftSequence: entry.request.draftSequence, ...outcome });
    await vi.advanceTimersByTimeAsync(0);
  }

  async function rejectAt(index: number, error: unknown): Promise<void> {
    const entry = pending[index];
    if (entry === undefined) throw new Error(`没有第 ${index} 个在途保存`);
    entry.reject(error);
    await vi.advanceTimersByTimeAsync(0);
  }

  /** 故意投递任意形状（含畸形）的适配器返回值，用于验证形状校验。 */
  async function resolveRaw(index: number, value: unknown): Promise<void> {
    const entry = pending[index];
    if (entry === undefined) throw new Error(`没有第 ${index} 个在途保存`);
    (entry.resolve as (outcome: unknown) => void)(value);
    await vi.advanceTimersByTimeAsync(0);
  }

  return {
    requests,
    pending,
    snapshots,
    session,
    settle,
    rejectAt,
    resolveRaw,
    type: (body) => session.onInput(body),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('草稿会话状态机', () => {
  it('初始状态为已保存且无未保存改动', () => {
    const h = createHarness({ body: '第一章', revision: 'rev-0' });
    const s = h.session.getSnapshot();

    expect(s.status).toBe('saved');
    expect(s.body).toBe('第一章');
    expect(s.revision).toBe('rev-0');
    expect(s.draftSequence).toBe(0);
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.conflict).toBeNull();
  });

  it('连续键入被防抖合并为一次保存，且发出的是最新正文与递增后的序号', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('a');
    h.type('ab');
    h.type('abc');
    expect(h.requests).toHaveLength(0);
    expect(h.session.getSnapshot().status).toBe('dirty');
    expect(h.session.getSnapshot().draftSequence).toBe(3);

    await vi.advanceTimersByTimeAsync(799);
    expect(h.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.body).toBe('abc');
    expect(h.requests[0]?.draftSequence).toBe(3);
    expect(h.requests[0]?.expectedRevision).toBe('rev-0');
    expect(h.session.getSnapshot().status).toBe('saving');
  });

  it('键入回已确认内容时不产生新草稿序号，也不派发保存', async () => {
    const h = createHarness({ body: '原文', debounceMs: 800 });

    h.type('原文改');
    expect(h.session.getSnapshot().draftSequence).toBe(1);
    h.type('原文');

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(0);
    const s = h.session.getSnapshot();
    expect(s.status).toBe('saved');
    expect(s.hasUnsavedChanges).toBe(false);
  });

  it('相同正文重复键入不产生新草稿序号', () => {
    const h = createHarness({ body: '' });
    h.type('x');
    h.type('x');
    expect(h.session.getSnapshot().draftSequence).toBe(1);
  });

  it('持续键入时最长等待到点必发，不会被防抖无限推迟', async () => {
    const h = createHarness({ debounceMs: DEFAULT_DEBOUNCE_MS, maxWaitMs: DEFAULT_MAX_WAIT_MS });

    // 每 700 ms 键入一次，全部落在 800 ms 防抖窗口内，因此每次都会重置防抖。
    h.type('0');
    for (let step = 1; step <= 7; step += 1) {
      await vi.advanceTimersByTimeAsync(700);
      h.type(`0${step}`);
    }
    // 从首次改动起已过 4900 ms，仍未派发。
    expect(h.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.requests).toHaveLength(1);
  });

  it('保存未回包时不并发派发第二个请求，首个结算后立即续派最新草稿', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('第一稿');
    await vi.advanceTimersByTimeAsync(800);
    expect(h.requests).toHaveLength(1);

    h.type('第一稿+2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(1);

    await h.settle(0, { ok: true, revision: 'rev-1' });
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.body).toBe('第一稿+2');
    expect(h.requests[1]?.expectedRevision).toBe('rev-1');
  });

  it('迟到结果不得推进版本，也不得把更新的草稿标记为已保存', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('v1');
    await vi.advanceTimersByTimeAsync(800);
    const first = h.requests[0];
    expect(first?.draftSequence).toBe(1);

    // 在途中继续键入。
    h.type('v2');
    await h.settle(0, { ok: true, revision: 'rev-1' });

    // 第一个请求确认的是它自己提交的正文，v2 仍是未保存状态。
    let s = h.session.getSnapshot();
    expect(s.revision).toBe('rev-1');
    expect(s.body).toBe('v2');
    expect(s.hasUnsavedChanges).toBe(true);
    expect(s.status).toBe('saving');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.body).toBe('v2');
    expect(h.requests[1]?.draftSequence).toBe(2);

    // IPC 边界上「同一个保存请求」的 promise 只会结算一次，重复 resolve 是空操作：
    // 不得回退版本、不得把 v2 标成已保存，也不得污染丢弃计数。
    // （真·迟到/重复结果走 `<= lastSettledSequence` 分支，由下面 take-external 用例覆盖。）
    const stale = h.pending[0];
    if (stale === undefined) throw new Error('缺少第一个在途保存');
    stale.resolve({ ok: true, draftSequence: 1, revision: 'rev-1-late' });
    await vi.advanceTimersByTimeAsync(0);

    s = h.session.getSnapshot();
    expect(s.revision).toBe('rev-1');
    expect(s.body).toBe('v2');
    expect(s.hasUnsavedChanges).toBe(true);
    expect(s.ignoredResults).toBe(0);

    await h.settle(1, { ok: true, revision: 'rev-2' });
    s = h.session.getSnapshot();
    expect(s.revision).toBe('rev-2');
    expect(s.status).toBe('saved');
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.lastConfirmedSequence).toBe(2);
  });

  it('正常流程不产生被丢弃的结果', async () => {
    const h = createHarness({ body: '' });

    h.type('y');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    await h.settle(0, { ok: true, revision: 'rev-1' });

    const s = h.session.getSnapshot();
    expect(s.status).toBe('saved');
    expect(s.ignoredResults).toBe(0);
  });

  it('结果序号与在途不符时按协议违例处理，正文与版本都不变', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('正文');
    await vi.advanceTimersByTimeAsync(800);
    const entry = h.pending[0];
    if (entry === undefined) throw new Error('缺少在途保存');
    entry.resolve({ ok: true, draftSequence: 99, revision: 'rev-99' });
    await vi.advanceTimersByTimeAsync(0);

    const s = h.session.getSnapshot();
    expect(s.lastErrorCode).toBe('SAVE_RESULT_SEQUENCE_MISMATCH');
    expect(s.revision).toBe('rev-0');
    expect(s.body).toBe('正文');
    expect(s.hasUnsavedChanges).toBe(true);
  });

  it('保存失败时保留正文并进入 error 状态', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('重要正文');
    await vi.advanceTimersByTimeAsync(800);
    await h.settle(0, { ok: false, code: 'SERVICE_UNAVAILABLE' });

    const s = h.session.getSnapshot();
    expect(s.status).toBe('error');
    expect(s.lastErrorCode).toBe('SERVICE_UNAVAILABLE');
    expect(s.body).toBe('重要正文');
    expect(s.hasUnsavedChanges).toBe(true);
  });

  it('适配器抛错等同于一次失败结算，不丢正文也不崩', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('正文');
    await vi.advanceTimersByTimeAsync(800);
    await h.rejectAt(0, new Error('IPC 通道已关闭'));

    const s = h.session.getSnapshot();
    expect(s.status).toBe('error');
    expect(s.lastErrorCode).toBe('SAVE_ADAPTER_THREW');
    expect(s.body).toBe('正文');
    expect(s.inFlightSequence).toBeNull();
  });

  it('适配器返回畸形结果时按失败结算，不卡在 saving 也不产生未处理拒绝', async () => {
    const malformedSamples: unknown[] = [
      undefined,
      null,
      'oops',
      {},
      { ok: true },
      { ok: false, draftSequence: Number.NaN },
    ];

    for (const malformed of malformedSamples) {
      const h = createHarness({ debounceMs: 800 });
      h.type('正文');
      await vi.advanceTimersByTimeAsync(800);
      await h.resolveRaw(0, malformed);

      const s = h.session.getSnapshot();
      const label = `畸形结果 ${JSON.stringify(malformed) ?? 'undefined'}`;
      expect(s.status, label).toBe('error');
      expect(s.lastErrorCode, label).toBe('SAVE_RESULT_MALFORMED');
      expect(s.inFlightSequence, label).toBeNull();
      expect(s.body, label).toBe('正文');
      expect(s.hasUnsavedChanges, label).toBe(true);
    }
  });

  it('失败后 retry 立即重派而不等防抖窗口', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('正文');
    await vi.advanceTimersByTimeAsync(800);
    await h.settle(0, { ok: false, code: 'DISK_FULL' });
    expect(h.requests).toHaveLength(1);

    h.session.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.body).toBe('正文');
  });

  it('flush 立即派发并等待目标序号的结果（切章/退出前冲刷）', async () => {
    const h = createHarness({ debounceMs: 10_000 });

    h.type('第一章正文');
    expect(h.requests).toHaveLength(0);

    const flushed = h.session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.body).toBe('第一章正文');

    await h.settle(0, { ok: true, revision: 'rev-1' });
    await expect(flushed).resolves.toMatchObject({ ok: true, draftSequence: 1 });
    expect(h.session.getSnapshot().status).toBe('saved');
  });

  it('flush 在无未保存改动时立即返回 null', async () => {
    const h = createHarness({ body: '已保存内容' });
    await expect(h.session.flush()).resolves.toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  it('存在未保存草稿时外部更新只记录冲突，正文一字不动', async () => {
    const h = createHarness({ body: '本地', revision: 'rev-0' });

    h.type('本地改动');
    const outcome = h.session.applyExternalUpdate({ revision: 'rev-external', body: '远端正文' });

    expect(outcome).toBe('conflict');
    const s = h.session.getSnapshot();
    expect(s.body).toBe('本地改动');
    expect(s.revision).toBe('rev-0');
    expect(s.conflict).toEqual({ externalRevision: 'rev-external', externalBody: '远端正文' });

    // 冲突未解决期间不得自动派发，避免用旧基线覆盖远端。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.requests).toHaveLength(0);
  });

  it('无未保存改动时外部更新直接应用', () => {
    const h = createHarness({ body: '旧内容', revision: 'rev-0' });

    expect(h.session.applyExternalUpdate({ revision: 'rev-1', body: '新内容' })).toBe('applied');
    const s = h.session.getSnapshot();
    expect(s.body).toBe('新内容');
    expect(s.revision).toBe('rev-1');
    expect(s.status).toBe('saved');
    expect(s.conflict).toBeNull();
  });

  it('裁决 take-external 采用外部正文与版本，并让旧在途结果失效', async () => {
    const h = createHarness({ body: '', revision: 'rev-0', debounceMs: 800 });

    h.type('本地草稿');
    await vi.advanceTimersByTimeAsync(800);
    expect(h.requests).toHaveLength(1);

    h.session.applyExternalUpdate({ revision: 'rev-ext', body: '远端正文' });
    h.session.resolveConflict('take-external');

    let s = h.session.getSnapshot();
    expect(s.body).toBe('远端正文');
    expect(s.revision).toBe('rev-ext');
    expect(s.conflict).toBeNull();
    expect(s.status).toBe('saved');

    // 旧在途请求属于被放弃的本地草稿，其结果不得改写版本。
    await h.settle(0, { ok: true, revision: 'rev-stale' });
    s = h.session.getSnapshot();
    expect(s.revision).toBe('rev-ext');
    expect(s.body).toBe('远端正文');
    expect(s.ignoredResults).toBeGreaterThanOrEqual(1);
  });

  it('裁决 keep-local 保留本地正文并把乐观锁基线挂到外部版本后立即重存', async () => {
    const h = createHarness({ body: '', revision: 'rev-0', debounceMs: 800 });

    h.type('本地正文');
    h.session.applyExternalUpdate({ revision: 'rev-ext', body: '远端正文' });
    expect(h.session.getSnapshot().conflict).not.toBeNull();

    h.session.resolveConflict('keep-local');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.body).toBe('本地正文');
    expect(h.requests[0]?.expectedRevision).toBe('rev-ext');
    expect(h.session.getSnapshot().conflict).toBeNull();
  });

  it('dispose 取消定时器，未决 flush 以 null 收束', async () => {
    const h = createHarness({ debounceMs: 10_000 });

    h.type('未保存');
    const flushed = h.session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);

    h.session.dispose();
    await expect(flushed).resolves.toBeNull();

    h.session.onInput('dispose 之后的键入会被忽略');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(1);
  });

  it('状态快照通过 onStateChange 推送且字段自洽', async () => {
    const h = createHarness({ debounceMs: 800 });

    h.type('a');
    h.type('ab');
    await vi.advanceTimersByTimeAsync(800);
    await h.settle(0, { ok: true, revision: 'rev-1' });

    expect(h.snapshots.length).toBeGreaterThan(0);
    const last = h.snapshots[h.snapshots.length - 1];
    expect(last?.status).toBe('saved');
    expect(last?.body).toBe('ab');
    expect(last?.draftSequence).toBe(2);
    expect(last?.lastConfirmedSequence).toBe(2);
    expect(last?.saveAttempts).toBe(1);
  });
});
