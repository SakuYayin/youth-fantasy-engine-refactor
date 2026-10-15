/**
 * 真实 db-worker ↔ SQLite 链路测试（不 mock 任何东西）。
 *
 * 与 `service-host.test.ts` 的分工：那边用替身验监督器行为，这里用真 worker 验
 * 「解析钩子能加载 @yfe 包 → 开库 → 迁移 → 用例分派 → 优雅停止」整条链。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceHost, type ServiceHost } from '../src/main/service-host.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HERE, '..', 'src', 'main', 'db-worker.mjs');

let tmpRoot = '';
let dbPath = '';
let host: ServiceHost;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yfe-desktop-'));
  dbPath = join(tmpRoot, 'nested', 'test.db'); // nested: 验证 worker 会自建父目录
  host = createServiceHost({ workerPath: WORKER_PATH });
  await host.start();
  const opened = await host.open(dbPath);
  expect(opened.ok, `open 失败：${JSON.stringify(opened)}`).toBe(true);
});

afterAll(async () => {
  await host.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('db-worker 启动与开库', () => {
  it('worker 通过解析钩子成功加载 @yfe 包并迁移出 schema v1', async () => {
    const status = await host.call('systemStatus', null);
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    const value = status.value as Record<string, unknown>;
    expect(value.databaseSchemaVersion).toBe(1);
    expect(value.databasePath).toBe(dbPath);
    expect(value.readOnly).toBe(false);
    expect(value.pendingOutboxCount).toBe(0);
    // 契约字段必须齐全——少一个字段前端的系统状态页就会渲染出 undefined
    for (const key of [
      'appVersion',
      'databaseSchemaVersion',
      'syncProtocolVersion',
      'pluginApiVersion',
      'resourceTemplateVersion',
      'databasePath',
      'readOnly',
      'lastSavedAt',
      'pendingOutboxCount',
    ]) {
      expect(Object.keys(value)).toContain(key);
    }
  });

  it('重复 open 同一路径是幂等的（reused=true），不会重跑迁移', async () => {
    const again = await host.call('open', { path: dbPath });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect((again.value as { reused: boolean }).reused).toBe(true);
    }
  });

  it('open 空路径返回 VALIDATION_FAILED，而不是抛异常', async () => {
    const result = await host.call('open', { path: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('open 到另一个路径被拒（同一 worker 同时只能持有一个库）', async () => {
    const result = await host.call('open', { path: join(tmpRoot, 'another.db') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STATE_INVALID_TRANSITION');
    }
  });
});

describe('db-worker 错误边界', () => {
  it('未知方法返回 NOT_IMPLEMENTED，且 worker 不会因此挂掉', async () => {
    const bogus = await host.call('definitelyNotAMethod', { any: 'thing' });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) {
      expect(bogus.error.code).toBe('NOT_IMPLEMENTED');
      expect(typeof bogus.error.message).toBe('string');
    }

    // 关键：坏请求之后 worker 仍然可用（一个坏调用不能拖垮服务）
    const status = await host.call('systemStatus', null);
    expect(status.ok).toBe(true);
  });

  it('错误载荷不含 cause 与堆栈（跨进程只允许出脱敏后的字段）', async () => {
    const result = await host.call('definitelyNotAMethod', null);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('    at ');
    expect(result.error).not.toHaveProperty('cause');
    // 允许出现的字段白名单
    for (const key of Object.keys(result.error)) {
      expect(['code', 'message', 'requestId', 'severity', 'retryable', 'detail']).toContain(key);
    }
  });
});

describe('db-worker 用例分派', () => {
  it('真实 worker 崩溃后自动重开原数据库，后续调用恢复可用', async () => {
    const oldPid = host.stats().pid
    host.forceKillWorker()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (host.stats().state !== 'ready' || host.stats().pid === oldPid)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const status = await host.call('systemStatus', null)
    expect(status.ok, JSON.stringify(status)).toBe(true)
    if (status.ok) expect((status.value as { databasePath: string }).databasePath).toBe(dbPath)
    expect(host.stats().pid).not.toBe(oldPid)
  })

  it('端到端链路：createProject → createDocument → saveDraft → getDocument 全部落到真实用例层', async () => {
    const workspaceId = 'w-selfcheck';
    const baseContext = () => ({ requestId: 'req-test', workspaceId });

    const created = await host.call('createProject', { context: baseContext(), name: '链路测试作品' });

    // 用例层已接线：这里**不再**保留「未落地就早退」的分支——早退会让
    // 「链路其实没通」伪装成通过。任何一环失败都直接断言失败。
    expect(created.ok, `createProject 应当成功：${JSON.stringify(created)}`).toBe(true);
    if (!created.ok) return;
    const bag = created.value as Record<string, any>;
    // 用例层权威形状是 `{ projectId, revision }`（contracts ProjectCreateOutput）
    const projectId: string | undefined = bag.projectId ?? bag.project?.id ?? bag.id;
    expect(typeof projectId).toBe('string');

    const document = await host.call('createDocument', {
      context: { ...baseContext(), projectId },
      projectId,
      kind: 'chapter',
      parentId: null,
      title: '第一章',
      placement: { mode: 'end' },
    });
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    const docBag = document.value as Record<string, any>;
    // 用例层权威形状是 `{ documentId, revision, orderKey }`
    const documentId: string | undefined = docBag.documentId ?? docBag.document?.id ?? docBag.id;
    expect(typeof documentId).toBe('string');

    const body = '中文往返测试 🙂\n第二行';
    const saved = await host.call('saveDraft', {
      context: { ...baseContext(), projectId },
      documentId,
      draftSequence: 1,
      body,
      sessionId: 'test-session',
    });
    expect(saved.ok, `saveDraft 应当成功：${JSON.stringify(saved)}`).toBe(true);

    const read = await host.call('getDocument', { context: baseContext(), documentId });
    expect(read.ok).toBe(true);
    if (read.ok) {
      const readBag = read.value as Record<string, any>;
      const readBack = readBag.document?.body ?? readBag.body;
      expect(readBack).toBe(body);
    }
  });
});
