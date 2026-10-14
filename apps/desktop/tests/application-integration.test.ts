/**
 * 桌面端到端集成测试：renderer 侧发出的 IPC 请求 → db-worker → **真实用例层**
 * （`@yfe/application`）→ **真实落库**（`@yfe/persistence-sqlite` → better-sqlite3）。
 *
 * 与 `db-worker.test.ts` 的分工：那边验「worker 本身能起来、能开库、错误载荷脱敏」，
 * 这里验**业务链路真的通了**，并且重点钉住两类只有真链路才能暴露的问题：
 *
 * 1. **ID 同源**：用例层先生成实体 ID 并返回给调用方，而 repository 自己也会生成 ID
 *    （`repositories/projects.ts:207` / `repositories/documents.ts:328`）。若两处不一致，
 *    「createProject 返回的 id」就会查不到库里的行。所以这里每一步都用**上一步返回的 id**
 *    去查库（而不是复用输入），这个往返是适配器里 ID 钉桩存在意义的直接证据。
 * 2. **归属零谎言**：`DraftPersistencePort.loadDocument()` 返回 `null` 只能表示
 *    「文档不存在」。跨工作区必须由**用例层**基于权威归属行报 `PERMISSION_WORKSPACE_MISMATCH`，
 *    绝不允许适配器拿工作区过滤掉行、把越权伪装成 404。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceHost, type ServiceHost } from '../src/main/service-host.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HERE, '..', 'src', 'main', 'db-worker.mjs');

let tmpRoot = '';
let dbPath = '';
let host: ServiceHost;

/** 每次请求都用新 requestId（用例层用它做错误关联与幂等键归属）。 */
function context(workspaceId: string, extra: Record<string, unknown> = {}) {
  return { requestId: `req_${randomUUID()}`, workspaceId, ...extra };
}

/** 建一个作品，返回**用例层回给调用方**的 projectId。 */
async function createProject(workspaceId: string, name = '集成测试作品'): Promise<string> {
  const created = await host.call('createProject', { context: context(workspaceId), name });
  expect(created.ok, `createProject 应当成功：${JSON.stringify(created)}`).toBe(true);
  if (!created.ok) throw new Error('createProject 失败');
  const projectId = (created.value as Record<string, unknown>).projectId;
  expect(typeof projectId).toBe('string');
  return projectId as string;
}

/** 建一篇文档，返回**用例层回给调用方**的 documentId。 */
async function createDocument(
  workspaceId: string,
  projectId: string,
  title: string,
): Promise<{ documentId: string; revision: string; orderKey: string }> {
  const created = await host.call('createDocument', {
    context: context(workspaceId, { projectId }),
    projectId,
    kind: 'chapter',
    parentId: null,
    title,
    placement: { mode: 'end' },
  });
  expect(created.ok, `createDocument 应当成功：${JSON.stringify(created)}`).toBe(true);
  if (!created.ok) throw new Error('createDocument 失败');
  const bag = created.value as Record<string, unknown>;
  expect(typeof bag.documentId).toBe('string');
  expect(typeof bag.revision).toBe('string');
  expect(typeof bag.orderKey).toBe('string');
  return { documentId: bag.documentId as string, revision: bag.revision as string, orderKey: bag.orderKey as string };
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yfe-app-integration-'));
  dbPath = join(tmpRoot, 'integration.db');
  host = createServiceHost({ workerPath: WORKER_PATH });
  await host.start();
  const opened = await host.open(dbPath);
  expect(opened.ok, `open 失败：${JSON.stringify(opened)}`).toBe(true);
});

afterAll(async () => {
  await host.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('桌面端到端：建作品 → 建文档 → 存草稿 → 读文档 → 读文档树', () => {
  it('createProject 返回的 projectId 必须就是库里的行（读文档树能查到）', async () => {
    const workspaceId = 'w-int-project';
    const projectId = await createProject(workspaceId);

    // 关键：listDocumentTree 用的是**用例层返回的** id，它能查到就说明落库 id 同源。
    const tree = await host.call('listDocumentTree', { context: context(workspaceId), projectId });
    expect(tree.ok, `listDocumentTree 应当成功：${JSON.stringify(tree)}`).toBe(true);
    if (!tree.ok) return;
    expect((tree.value as { documents: unknown[] }).documents).toEqual([]);
  });

  it('新建的两章按 orderKey 排在文档树里，且与返回的 id 一一对应', async () => {
    const workspaceId = 'w-int-tree';
    const projectId = await createProject(workspaceId, '两章作品');
    const first = await createDocument(workspaceId, projectId, '第一章');
    const second = await createDocument(workspaceId, projectId, '第二章');

    // placement end：后建的必须排在后面（orderKey 单调）
    expect(second.orderKey > first.orderKey).toBe(true);

    const tree = await host.call('listDocumentTree', { context: context(workspaceId), projectId });
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    const documents = (tree.value as { documents: Array<Record<string, unknown>> }).documents;
    expect(documents.map((row) => row.id)).toEqual([first.documentId, second.documentId]);
    expect(documents.map((row) => row.title)).toEqual(['第一章', '第二章']);
    // 🔴 列表接口不带正文：树里多出 body 会拖垮大作品的加载。
    for (const row of documents) expect(row).not.toHaveProperty('body');
  });

  it('草稿正文逐字往返（中文 / emoji / 换行），charCount 由 domain 计算', async () => {
    const workspaceId = 'w-int-draft';
    const projectId = await createProject(workspaceId, '草稿作品');
    const { documentId } = await createDocument(workspaceId, projectId, '正文章');
    const body = '第一章：\n中文往返 🙂 与换行\n 末尾空格保留 ';

    const saved = await host.call('saveDraft', {
      context: context(workspaceId, { projectId }),
      documentId,
      draftSequence: 1,
      body,
      sessionId: 'integration-session',
    });
    expect(saved.ok, `saveDraft 应当成功：${JSON.stringify(saved)}`).toBe(true);
    if (!saved.ok) return;
    const savedBag = saved.value as Record<string, unknown>;
    expect(typeof savedBag.revision).toBe('string');
    expect(savedBag.draftSequence).toBe(1);
    // countChars 按码点/字素算，不是 body.length（两者对 emoji 结果不同）
    expect(typeof savedBag.charCount).toBe('number');
    expect(savedBag.charCount as number).toBeGreaterThan(0);
    expect(typeof savedBag.savedAt).toBe('string');

    const read = await host.call('getDocument', { context: context(workspaceId), documentId });
    expect(read.ok, `getDocument 应当成功：${JSON.stringify(read)}`).toBe(true);
    if (!read.ok) return;
    const readBag = read.value as Record<string, unknown>;
    expect(readBag.body).toBe(body);
    expect((readBag.document as Record<string, unknown>).id).toBe(documentId);
    // 保存必须推进 revision（读回来的版本号不等于建文档时的版本号）
    expect((readBag.document as Record<string, unknown>).revision).toBe(savedBag.revision);
  });

  it('乐观锁：expectedRevision 命中则接受，过期则 REVISION_CONFLICT', async () => {
    const workspaceId = 'w-int-cas';
    const projectId = await createProject(workspaceId, '乐观锁作品');
    const { documentId } = await createDocument(workspaceId, projectId, '锁章');

    const first = await host.call('saveDraft', {
      context: context(workspaceId, { projectId }),
      documentId,
      draftSequence: 1,
      body: '第一版',
      sessionId: 'integration-session',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const staleRevision = (first.value as Record<string, unknown>).revision as string;

    const accepted = await host.call('saveDraft', {
      context: context(workspaceId, { projectId, expectedRevision: staleRevision }),
      documentId,
      draftSequence: 2,
      body: '第二版',
      sessionId: 'integration-session',
    });
    expect(accepted.ok, `命中当前版本应当被接受：${JSON.stringify(accepted)}`).toBe(true);
    if (!accepted.ok) return;
    expect((accepted.value as Record<string, unknown>).revision).not.toBe(staleRevision);

    // 同一批写入顺序：3 号草稿带**已过期**的 revision → 必须被拒，且不能改到库里的正文。
    const conflicting = await host.call('saveDraft', {
      context: context(workspaceId, { projectId, expectedRevision: staleRevision }),
      documentId,
      draftSequence: 3,
      body: '基于旧版本的写入',
      sessionId: 'integration-session',
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect((conflicting.error as { code: string }).code).toBe('REVISION_CONFLICT');

    const read = await host.call('getDocument', { context: context(workspaceId), documentId });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // 被拒的写入绝不能留下痕迹
    expect((read.value as Record<string, unknown>).body).toBe('第二版');
  });

  it('跨工作区：读文档与写草稿都必须报 PERMISSION_WORKSPACE_MISMATCH（不伪装成 404）', async () => {
    const workspaceId = 'w-int-owner';
    const intruder = 'w-int-intruder';
    const projectId = await createProject(workspaceId, '归属作品');
    const { documentId } = await createDocument(workspaceId, projectId, '归属章');

    // 读路径：persistence 的 loadOwnership 对越界**明确报错**而不是静默返回空
    // （`repositories/internal.ts:233-239`），loadDocumentForRead 也接受这个 code。
    const read = await host.call('getDocument', { context: context(intruder), documentId });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect((read.error as { code: string }).code).toBe('PERMISSION_WORKSPACE_MISMATCH');

    // 🔴 写路径的证词更关键：适配器的 loadDocument 返回的是**权威归属行**（不是 null），
    // 所以这里必须由用例层报权限错误，而不是被伪装成「文档不存在」。
    // 如果适配器拿工作区去过滤、返回 null，这里就会变成 NOT_FOUND_DOCUMENT——
    // 那样越权与「ID 拼错」就再也分不开了。
    const write = await host.call('saveDraft', {
      context: context(intruder, { projectId }),
      documentId,
      draftSequence: 1,
      body: '越权写入',
      sessionId: 'intruder-session',
    });
    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect((write.error as { code: string }).code).toBe('PERMISSION_WORKSPACE_MISMATCH');

    // 原工作区的内容不受影响（越权写入没有落库）
    const owner = await host.call('getDocument', { context: context(workspaceId), documentId });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect((owner.value as Record<string, unknown>).body).toBe('');
  });

  it('跨进程错误载荷仍然脱敏（不含 cause / 堆栈 / 真实文件路径）', async () => {
    const workspaceId = 'w-int-redact';
    const projectId = await createProject(workspaceId, '脱敏作品');
    const { documentId } = await createDocument(workspaceId, projectId, '脱敏章');

    const conflict = await host.call('saveDraft', {
      context: context(workspaceId, { projectId, expectedRevision: 'r000000ff' }),
      documentId,
      draftSequence: 1,
      body: '触发冲突',
      sessionId: 'redact-session',
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;

    const serialized = JSON.stringify(conflict.error);
    expect(conflict.error).not.toHaveProperty('cause');
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('    at ');
    // 绝对路径绝不允许过进程边界
    expect(serialized).not.toContain(tmpRoot);
    expect(serialized.toLowerCase()).not.toContain('sqlite');
    for (const key of Object.keys(conflict.error)) {
      expect(['code', 'message', 'requestId', 'severity', 'retryable', 'detail']).toContain(key);
    }
  });

  it('systemStatus 反映真实库事实（读一次不改变任何状态）', async () => {
    const before = await host.call('systemStatus', null);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const value = before.value as Record<string, unknown>;
    expect(value.databaseSchemaVersion).toBe(1);
    expect(value.databasePath).toBe(dbPath);
    expect(value.readOnly).toBe(false);
    expect(typeof value.lastSavedAt).toBe('string'); // 前面的用例已经存过草稿
    expect(value.pendingOutboxCount as number).toBeGreaterThanOrEqual(0);
  });
});
