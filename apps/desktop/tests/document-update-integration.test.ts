/**
 * 桌面端到端集成测试：章节管理（重命名 / 重排 / 级联软删）真实链路。
 *
 * IPC `updateDocument` / `deleteDocument` → db-worker → `@yfe/application` 用例 →
 * **真实落库**（better-sqlite3）。重点钉住四类只有真链路才能暴露的问题：
 *
 * 1. **重排回传 orderKey**：调用方用它免重拉整棵树；树的新顺序必须与 orderKey 一致。
 * 2. **乐观锁 CAS**：过期 `expectedRevision` → `REVISION_CONFLICT`，行不变。
 * 3. **级联软删**：deletedCount 含子树；树隐藏墓碑，`includeDeleted` 能看到。
 * 4. **越权零谎言**：跨工作区报 `PERMISSION_WORKSPACE_MISMATCH`，绝不伪装成 404。
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

function context(workspaceId: string, extra: Record<string, unknown> = {}) {
  return { requestId: `req_${randomUUID()}`, workspaceId, ...extra };
}

async function createProject(workspaceId: string, name = '章节管理集成作品'): Promise<string> {
  const created = await host.call('createProject', { context: context(workspaceId), name });
  expect(created.ok, `createProject 应当成功：${JSON.stringify(created)}`).toBe(true);
  if (!created.ok) throw new Error('createProject 失败');
  return (created.value as Record<string, unknown>).projectId as string;
}

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
  return {
    documentId: bag.documentId as string,
    revision: bag.revision as string,
    orderKey: bag.orderKey as string,
  };
}

interface TreeRow {
  id: string;
  title: string;
  orderKey: string;
  deleted: number;
}

async function readTree(workspaceId: string, projectId: string, includeDeleted = false): Promise<TreeRow[]> {
  const listed = await host.call('listDocumentTree', {
    context: context(workspaceId),
    projectId,
    ...(includeDeleted ? { includeDeleted: true } : {}),
  });
  expect(listed.ok, `listDocumentTree 应当成功：${JSON.stringify(listed)}`).toBe(true);
  if (!listed.ok) throw new Error('listDocumentTree 失败');
  return (listed.value as { documents: TreeRow[] }).documents;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yfe-doc-update-'));
  dbPath = join(tmpRoot, 'doc-update.db');
  host = createServiceHost({ workerPath: WORKER_PATH });
  await host.start();
  const opened = await host.open(dbPath);
  expect(opened.ok, `open 失败：${JSON.stringify(opened)}`).toBe(true);
});

afterAll(async () => {
  await host.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('章节管理端到端：重命名 / 重排 / 级联软删', () => {
  it('重命名：revision 推进，树反映新标题', async () => {
    const ws = 'ws_doc_rename';
    const projectId = await createProject(ws);
    const doc = await createDocument(ws, projectId, '第一章');
    const updated = await host.call('updateDocument', {
      context: context(ws, { projectId, expectedRevision: doc.revision }),
      documentId: doc.documentId,
      title: '第一章（改名）',
    });
    expect(updated.ok, `updateDocument 应当成功：${JSON.stringify(updated)}`).toBe(true);
    if (!updated.ok) return;
    const bag = updated.value as Record<string, unknown>;
    expect(typeof bag.revision).toBe('string');
    expect(bag.revision).not.toBe(doc.revision);
    const tree = await readTree(ws, projectId);
    expect(tree.map((row) => row.title)).toContain('第一章（改名）');
    expect(tree.map((row) => row.title)).not.toContain('第一章');
  });

  it('重排：返回新 orderKey，树的新顺序与 orderKey 一致', async () => {
    const ws = 'ws_doc_reorder';
    const projectId = await createProject(ws);
    const first = await createDocument(ws, projectId, '甲');
    const second = await createDocument(ws, projectId, '乙');
    const third = await createDocument(ws, projectId, '丙');
    // 把「甲」移到「丙」之后 → 顺序变成 乙、丙、甲
    const moved = await host.call('updateDocument', {
      context: context(ws, { projectId, expectedRevision: first.revision }),
      documentId: first.documentId,
      placement: { mode: 'after', afterId: third.documentId },
    });
    expect(moved.ok, `updateDocument(placement) 应当成功：${JSON.stringify(moved)}`).toBe(true);
    if (!moved.ok) return;
    const bag = moved.value as Record<string, unknown>;
    expect(typeof bag.orderKey).toBe('string');
    const tree = await readTree(ws, projectId);
    expect(tree.map((row) => row.title)).toEqual(['乙', '丙', '甲']);
    expect(tree.find((row) => row.id === first.documentId)?.orderKey).toBe(bag.orderKey);
    // 其余两篇相对顺序不变：乙 仍在 丙 之前
    expect(tree.find((row) => row.id === second.documentId)?.title).toBe('乙');
    const keys = tree.map((row) => row.orderKey);
    expect(keys[1] < keys[2]).toBe(true); // 丙 在 甲 之前
  });

  it('重命名 + 重排同时给：两步都生效，orderKey 有值', async () => {
    const ws = 'ws_doc_both';
    const projectId = await createProject(ws);
    const first = await createDocument(ws, projectId, '第一');
    const second = await createDocument(ws, projectId, '第二');
    const moved = await host.call('updateDocument', {
      context: context(ws, { projectId }),
      documentId: first.documentId,
      title: '第一（新）',
      placement: { mode: 'after', afterId: second.documentId },
    });
    expect(moved.ok, `应当成功：${JSON.stringify(moved)}`).toBe(true);
    if (!moved.ok) return;
    const bag = moved.value as Record<string, unknown>;
    expect(typeof bag.orderKey).toBe('string');
    const tree = await readTree(ws, projectId);
    expect(tree.map((row) => row.title)).toEqual(['第二', '第一（新）']);
  });

  it('title 与 placement 都不给 → VALIDATION_FAILED', async () => {
    const ws = 'ws_doc_empty';
    const projectId = await createProject(ws);
    const doc = await createDocument(ws, projectId, '第一章');
    const updated = await host.call('updateDocument', {
      context: context(ws, { projectId }),
      documentId: doc.documentId,
    });
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect((updated.error as Record<string, unknown>).code).toBe('VALIDATION_FAILED');
  });

  it('过期 expectedRevision → REVISION_CONFLICT，标题不变', async () => {
    const ws = 'ws_doc_conflict';
    const projectId = await createProject(ws);
    const doc = await createDocument(ws, projectId, '第一章');
    const first = await host.call('updateDocument', {
      context: context(ws, { projectId }),
      documentId: doc.documentId,
      title: '第一次改名',
    });
    expect(first.ok).toBe(true);
    const second = await host.call('updateDocument', {
      context: context(ws, { projectId, expectedRevision: doc.revision }),
      documentId: doc.documentId,
      title: '第二次改名',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect((second.error as Record<string, unknown>).code).toBe('REVISION_CONFLICT');
    const tree = await readTree(ws, projectId);
    expect(tree.map((row) => row.title)).toContain('第一次改名');
    expect(tree.map((row) => row.title)).not.toContain('第二次改名');
  });

  it('跨工作区更新 → PERMISSION_WORKSPACE_MISMATCH（绝不伪装成 404）', async () => {
    const wsA = 'ws_doc_ws_a';
    const projectId = await createProject(wsA);
    const doc = await createDocument(wsA, projectId, '第一章');
    const updated = await host.call('updateDocument', {
      context: context('ws_doc_ws_b', { projectId }),
      documentId: doc.documentId,
      title: '越权改名',
    });
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect((updated.error as Record<string, unknown>).code).toBe('PERMISSION_WORKSPACE_MISMATCH');
  });

  it('级联软删：deletedCount 含子树，树隐藏墓碑而 includeDeleted 能看到', async () => {
    const ws = 'ws_doc_delete';
    const projectId = await createProject(ws);
    const parent = await createDocument(ws, projectId, '卷一');
    const child = await host.call('createDocument', {
      context: context(ws, { projectId }),
      projectId,
      kind: 'chapter',
      parentId: parent.documentId,
      title: '第一章',
      placement: { mode: 'end' },
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const childBag = child.value as Record<string, unknown>;
    const other = await createDocument(ws, projectId, '卷二');

    const removed = await host.call('deleteDocument', {
      context: context(ws, { projectId, expectedRevision: parent.revision }),
      documentId: parent.documentId,
    });
    expect(removed.ok, `deleteDocument 应当成功：${JSON.stringify(removed)}`).toBe(true);
    if (!removed.ok) return;
    const bag = removed.value as Record<string, unknown>;
    expect(bag.deletedCount).toBe(2);
    expect(typeof bag.revision).toBe('string');

    // 活树隐藏墓碑
    const liveTree = await readTree(ws, projectId);
    expect(liveTree.map((row) => row.id)).toEqual([other.documentId]);
    // includeDeleted 能看到墓碑
    const fullTree = await readTree(ws, projectId, true);
    expect(fullTree.length).toBe(3);
    expect(fullTree.find((row) => row.id === parent.documentId)?.deleted).toBe(1);
    expect(fullTree.find((row) => row.id === (childBag.documentId as string))?.deleted).toBe(1);
  });

  it('删除后 getDocument → NOT_FOUND_DOCUMENT', async () => {
    const ws = 'ws_doc_get_after_delete';
    const projectId = await createProject(ws);
    const doc = await createDocument(ws, projectId, '第一章');
    const removed = await host.call('deleteDocument', {
      context: context(ws, { projectId }),
      documentId: doc.documentId,
    });
    expect(removed.ok).toBe(true);
    const got = await host.call('getDocument', {
      context: context(ws),
      documentId: doc.documentId,
    });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect((got.error as Record<string, unknown>).code).toBe('NOT_FOUND_DOCUMENT');
  });
});
