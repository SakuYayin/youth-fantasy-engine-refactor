/**
 * 桌面端到端集成测试（设定实体）：renderer 侧发出的 IPC 请求 → db-worker → **真实用例层**
 * （`@yfe/application`）→ **真实落库**（`@yfe/persistence-sqlite` → better-sqlite3）。
 *
 * W6 的目标是让 29 个数据驱动的旧页签（5 form / 6 card / 18 table）真正读写同一张
 * `settings_entities`。只有真链路才能钉住的三件事：
 *
 * 1. **动态字段真的落进 `values_json`**：表里没有「阵营」这样的列，往返靠 JSON 文本；
 * 2. **revision 真的递增**：桌面端 revision 是 `rev_<uuid>`（不可比大小），所以
 *    「递增」的权威证据是库里的 `revision_seq` +1；
 * 3. **授权只用库内事实**：跨工作区必须 `PERMISSION_WORKSPACE_MISMATCH`，
 *    不能因为过滤掉了行就退化成 404。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceHost, type ServiceHost } from '../src/main/service-host.mjs';
import { createAppState, type RendererClientPort } from '../src/renderer/app-state.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HERE, '..', 'src', 'main', 'db-worker.mjs');
const TEMPLATE = 'tpl-faction';

let tmpRoot = '';
let dbPath = '';
let host: ServiceHost;

/** 每次请求都用新 requestId（用例层用它做错误关联与幂等键归属）。 */
function context(workspaceId: string, extra: Record<string, unknown> = {}) {
  return { requestId: `req_${randomUUID()}`, workspaceId, ...extra };
}

/** 建一个作品，返回**用例层回给调用方**的 projectId。 */
async function createProject(workspaceId: string, name = '设定集成作品'): Promise<string> {
  const created = await host.call('createProject', { context: context(workspaceId), name });
  expect(created.ok, `createProject 应当成功：${JSON.stringify(created)}`).toBe(true);
  if (!created.ok) throw new Error('createProject 失败');
  const projectId = (created.value as Record<string, unknown>).projectId;
  expect(typeof projectId).toBe('string');
  return projectId as string;
}

/** 建一条设定实体，返回**用例层回给调用方**的 id / revision / orderKey。 */
async function saveSettingsEntity(
  workspaceId: string,
  projectId: string,
  patch: Record<string, unknown> = {},
): Promise<{ entityId: string; revision: string; orderKey: string }> {
  const saved = await host.call('saveSettingsEntity', {
    context: context(workspaceId, { projectId }),
    projectId,
    schemaTemplateId: TEMPLATE,
    name: '青云门',
    values: { 阵营: '正道' },
    ...patch,
  });
  expect(saved.ok, `saveSettingsEntity 应当成功：${JSON.stringify(saved)}`).toBe(true);
  if (!saved.ok) throw new Error('saveSettingsEntity 失败');
  const bag = saved.value as Record<string, unknown>;
  expect(typeof bag.entityId).toBe('string');
  expect(typeof bag.revision).toBe('string');
  expect(typeof bag.orderKey).toBe('string');
  return {
    entityId: bag.entityId as string,
    revision: bag.revision as string,
    orderKey: bag.orderKey as string,
  };
}

/** 直接读库：拿权威的 `revision_seq` / `values_json`（绕过应用层，避免自证）。 */
function inspect<T>(run: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yfe-settings-integration-'));
  dbPath = join(tmpRoot, 'settings.db');
  host = createServiceHost({ workerPath: WORKER_PATH });
  await host.start();
  const opened = await host.open(dbPath);
  expect(opened.ok, `open 失败：${JSON.stringify(opened)}`).toBe(true);
});

afterAll(async () => {
  await host.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('桌面端到端：建作品 → 建设定实体 → 读回 → 更新（revision 递增）', () => {
  it('新建返回的 entityId 能读回，更新后 revision 变化且库内 revision_seq +1', async () => {
    const workspaceId = 'w-settings-crud';
    const projectId = await createProject(workspaceId, '设定往返作品');

    // 1) 新建：动态字段（含中文键、嵌套对象、数组）原样进 values_json。
    const created = await saveSettingsEntity(workspaceId, projectId, {
      name: '青云门',
      values: { 阵营: '正道', 成员: ['张三', '李四'], 资源: { 灵石: 1200 } },
    });
    expect(created.entityId).toMatch(/^wld_/);
    expect(created.orderKey.length).toBeGreaterThan(0);

    // 2) 读回：用**上一步返回的 id**（而不是复用输入）——id 同源的直接证据。
    const read = await host.call('getSettingsEntity', {
      context: context(workspaceId),
      entityId: created.entityId,
    });
    expect(read.ok, `getSettingsEntity 应当成功：${JSON.stringify(read)}`).toBe(true);
    if (!read.ok) return;
    const entity = (read.value as { entity: Record<string, unknown> }).entity;
    expect(entity.id).toBe(created.entityId);
    expect(entity.projectId).toBe(projectId);
    expect(entity.schemaTemplateId).toBe(TEMPLATE);
    expect(entity.name).toBe('青云门');
    expect(entity.values).toEqual({ 阵营: '正道', 成员: ['张三', '李四'], 资源: { 灵石: 1200 } });
    expect(entity.revision).toBe(created.revision);

    // 库里只有 values_json 一列承载动态字段，「阵营」不是一列。
    const columns = inspect((db) =>
      (db.prepare("SELECT name FROM pragma_table_info('settings_entities')").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    expect(columns).toContain('values_json');
    expect(columns).not.toContain('阵营');
    expect(inspect((db) => db.prepare('SELECT revision_seq AS n, values_json AS json FROM settings_entities WHERE id = ?').get(created.entityId))).toEqual({
      n: 1,
      json: JSON.stringify({ 阵营: '正道', 成员: ['张三', '李四'], 资源: { 灵石: 1200 } }),
    });

    // 3) 更新：expectedRevision 用读回来的当前版本。
    const updated = await host.call('saveSettingsEntity', {
      context: context(workspaceId, { projectId, expectedRevision: created.revision }),
      entityId: created.entityId,
      projectId,
      schemaTemplateId: TEMPLATE,
      name: '青云门（改名）',
      values: { 阵营: '正道' },
    });
    expect(updated.ok, `更新应当成功：${JSON.stringify(updated)}`).toBe(true);
    if (!updated.ok) return;
    const updatedBag = updated.value as Record<string, unknown>;
    expect(updatedBag.entityId).toBe(created.entityId);
    // revision 是 rev_<uuid>：不可比大小，但必须变；递增的权威证据是 revision_seq。
    expect(updatedBag.revision).not.toBe(created.revision);
    expect(updatedBag.orderKey).toBe(created.orderKey);
    expect(inspect((db) => db.prepare('SELECT revision_seq AS n, name AS name FROM settings_entities WHERE id = ?').get(created.entityId))).toEqual({
      n: 2,
      name: '青云门（改名）',
    });

    // 再读回：更新后的值是**整体替换**后的完整字段集，不是合并结果。
    const reread = await host.call('getSettingsEntity', {
      context: context(workspaceId),
      entityId: created.entityId,
    });
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const rereadEntity = (reread.value as { entity: Record<string, unknown> }).entity;
    expect(rereadEntity.revision).toBe(updatedBag.revision);
    expect(rereadEntity.values).toEqual({ 阵营: '正道' });
  });

  it('列表：按模板过滤、按 orderKey 排序、软删默认不可见', async () => {
    const workspaceId = 'w-settings-list';
    const projectId = await createProject(workspaceId, '列表作品');
    const first = await saveSettingsEntity(workspaceId, projectId, { name: '门派甲', orderKey: 'a1' });
    const second = await saveSettingsEntity(workspaceId, projectId, { name: '门派乙', orderKey: 'a2' });
    // 另一张模板的设定不该出现在按模板过滤的结果里。
    await saveSettingsEntity(workspaceId, projectId, { name: '地点甲', schemaTemplateId: 'tpl-place' });

    const all = await host.call('listSettingsEntities', { context: context(workspaceId), projectId });
    expect(all.ok, `listSettingsEntities 应当成功：${JSON.stringify(all)}`).toBe(true);
    if (!all.ok) return;
    const entities = (all.value as { entities: Array<Record<string, unknown>> }).entities;
    expect(entities.map((row) => row.name)).toEqual(['门派甲', '门派乙', '地点甲']);
    expect(entities.map((row) => row.orderKey)).toEqual(['a1', 'a2', 'a3']);
    expect(entities.map((row) => row.id)).toEqual([first.entityId, second.entityId, entities[2]!.id]);

    const filtered = await host.call('listSettingsEntities', {
      context: context(workspaceId),
      projectId,
      schemaTemplateId: TEMPLATE,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(
      (filtered.value as { entities: Array<Record<string, unknown>> }).entities.map((row) => row.name),
    ).toEqual(['门派甲', '门派乙']);

    // 工作区级列表（不带 projectId）也能读到，但不能读到别的工作区的行。
    const otherProject = await createProject(workspaceId, '同一工作区的第二部作品');
    await saveSettingsEntity(workspaceId, otherProject, { name: '第二部的门派' });
    const scoped = await host.call('listSettingsEntities', {
      context: context(workspaceId),
      schemaTemplateId: TEMPLATE,
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const names = (scoped.value as { entities: Array<Record<string, unknown>> }).entities.map(
      (row) => row.name,
    );
    expect(names).toContain('第二部的门派');
    expect(names).toContain('门派甲');
  });

  it('显式 orderKey 新建（Placement explicit）被原样采用，且不撞已有的键', async () => {
    const workspaceId = 'w-settings-order';
    const projectId = await createProject(workspaceId, '排序作品');
    await saveSettingsEntity(workspaceId, projectId, { name: '甲', orderKey: 'a100' });
    await saveSettingsEntity(workspaceId, projectId, { name: '乙', orderKey: 'a200' });
    // 插在两个中间：界面算好键传下来，存储层不许「重排到末位」。
    const middle = await saveSettingsEntity(workspaceId, projectId, { name: '甲与乙之间', orderKey: 'a150' });
    expect(middle.orderKey).toBe('a150');

    const listed = await host.call('listSettingsEntities', { context: context(workspaceId), projectId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(
      (listed.value as { entities: Array<Record<string, unknown>> }).entities.map((row) => row.name),
    ).toEqual(['甲', '甲与乙之间', '乙']);
  });

  it('乐观锁与跨工作区：过期 revision 被拒且不改库；越权返回 PERMISSION_WORKSPACE_MISMATCH', async () => {
    const workspaceId = 'w-settings-guard';
    const projectId = await createProject(workspaceId, '守卫作品');
    const created = await saveSettingsEntity(workspaceId, projectId, { name: '被守护的设定' });

    const stale = await host.call('saveSettingsEntity', {
      context: context(workspaceId, { projectId, expectedRevision: 'rev_not-the-current-one' }),
      entityId: created.entityId,
      projectId,
      schemaTemplateId: TEMPLATE,
      name: '偷偷改掉',
      values: { 阵营: '正道' },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('REVISION_CONFLICT');
    expect(inspect((db) => db.prepare('SELECT name AS name, revision_seq AS n FROM settings_entities WHERE id = ?').get(created.entityId))).toEqual({
      name: '被守护的设定',
      n: 1,
    });

    // 换工作区读同一条：不是 404，而是明确的越权错误。
    const foreignRead = await host.call('getSettingsEntity', {
      context: context('w-settings-other'),
      entityId: created.entityId,
    });
    expect(foreignRead.ok).toBe(false);
    if (!foreignRead.ok) expect(foreignRead.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH');

    const foreignWrite = await host.call('saveSettingsEntity', {
      context: context('w-settings-other', { projectId }),
      entityId: created.entityId,
      projectId,
      schemaTemplateId: TEMPLATE,
      name: '越权改名',
      values: { 阵营: '邪道' },
    });
    expect(foreignWrite.ok).toBe(false);
    if (!foreignWrite.ok) expect(foreignWrite.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH');

    // 别的工作区按 projectId 列表：不是「空数组」，而是明确的越权错误——
    // 返回空数组会把「这个作品名下有东西但你没权限」伪装成「什么都没有」。
    const foreignList = await host.call('listSettingsEntities', {
      context: context('w-settings-other'),
      projectId,
    });
    expect(foreignList.ok).toBe(false);
    if (!foreignList.ok) expect(foreignList.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH');

    // 工作区级列表（不带 projectId）必须只回自己工作区的行。
    const foreignWorkspaceList = await host.call('listSettingsEntities', {
      context: context('w-settings-other'),
    });
    expect(foreignWorkspaceList.ok).toBe(true);
    if (!foreignWorkspaceList.ok) return;
    expect((foreignWorkspaceList.value as { entities: unknown[] }).entities).toEqual([]);
  });

  it('幂等：同键同参只建一条（worker 强杀后重放仍同一条），换参明确 IDEMPOTENCY_KEY_REUSED', async () => {
    const workspaceId = 'w-settings-idem';
    const projectId = await createProject(workspaceId, '幂等作品');
    const input = {
      context: context(workspaceId, { projectId, idempotencyKey: 'settings-form-key-1' }),
      projectId,
      schemaTemplateId: TEMPLATE,
      name: '幂等门派',
      values: { 阵营: '正道' },
    };
    const [first, duplicate] = await Promise.all([
      host.call('saveSettingsEntity', input),
      host.call('saveSettingsEntity', input),
    ]);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(duplicate).toEqual(first);

    const oldPid = host.stats().pid;
    host.forceKillWorker();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (host.stats().state !== 'ready' || host.stats().pid === oldPid)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await host.call('saveSettingsEntity', input)).toEqual(first);

    const changed = await host.call('saveSettingsEntity', { ...input, name: '同键另一条' });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect(
      inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM settings_entities WHERE name IN (?, ?)').get('幂等门派', '同键另一条')),
    ).toEqual({ n: 1 });
  });

  it('错误载荷脱敏：跨工作区错误序列化后不含 cause / 堆栈 / 库路径', async () => {
    const workspaceId = 'w-settings-redact';
    const projectId = await createProject(workspaceId, '脱敏作品');
    const created = await saveSettingsEntity(workspaceId, projectId, { name: '脱敏设定' });

    const failed = await host.call('getSettingsEntity', {
      context: context('w-settings-redact-other'),
      entityId: created.entityId,
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    // 字段白名单：越权错误带 `detail`（field），仅此而已——没有 cause、没有堆栈。
    for (const key of Object.keys(failed.error)) {
      expect(['code', 'message', 'requestId', 'severity', 'retryable', 'detail']).toContain(key);
    }
    expect(failed.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH');
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('    at ');
    expect(serialized).not.toContain('.db');
    expect(serialized).not.toContain(tmpRoot);
  });
});

describe('桌面端到端：渲染层状态机的设定实体通道', () => {
  it('真 IPC + 真落库：提交后列表与选中项都拿到权威 revision，更新走乐观锁', async () => {
    const methods = [
      'systemStatus',
      'listDocumentTree',
      'getDocument',
      'createProject',
      'createDocument',
      'saveDraft',
      'listSettingsEntities',
      'getSettingsEntity',
      'saveSettingsEntity',
    ];
    let remembered: string | null = null;
    const client = Object.fromEntries(
      methods.map((method) => [method, (payload: unknown) => host.call(method, payload)]),
    ) as unknown as RendererClientPort;
    const state = createAppState({
      client,
      workspaceId: 'w-settings-renderer',
      projectStore: {
        read: () => remembered,
        write: (id: string | null) => {
          remembered = id;
        },
      },
      newRequestId: () => `req_${randomUUID()}`,
      newSessionId: () => `ui_${randomUUID()}`,
    });
    try {
      await state.start();
      expect(await state.createProject('渲染层设定作品')).toBe(true);

      // 新建：entityId 由服务端用例生成，客户端传 null。
      const submitted = await state.submitSettingsEntity({
        schemaTemplateId: TEMPLATE,
        name: '太虚剑宗',
        values: { 阵营: '正道', 掌门: '李长生' },
        idempotencyKey: 'renderer-form-1',
      });
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
      if (!submitted.ok) return;
      expect(submitted.entityId).toMatch(/^wld_/);

      expect(await state.loadSettingsEntities({ schemaTemplateId: TEMPLATE })).toBe(true);
      const snapshot = state.getSnapshot();
      expect(snapshot.settingsEntities.map((entity) => entity.name)).toEqual(['太虚剑宗']);
      expect(snapshot.settingsEntities[0]?.values).toEqual({ 阵营: '正道', 掌门: '李长生' });
      // 服务端只回 entityId/revision/orderKey，界面用的是状态机自己合并出来的权威版本。
      expect(snapshot.settingsEntities[0]?.revision).toBe(submitted.revision);
      expect(snapshot.selectedSettingsEntityId).toBe(submitted.entityId);
      expect(snapshot.settingsLoading).toBe(false);

      // 选中已载入的实体不该再打一次 IPC（本地命中）。
      expect(await state.selectSettingsEntity(submitted.entityId)).toBe(true);

      // 更新：省略 expectedRevision → 状态机自动用已载入的 revision，更新应当被接受。
      const updated = await state.submitSettingsEntity({
        entityId: submitted.entityId,
        schemaTemplateId: TEMPLATE,
        name: '太虚剑宗（改名）',
        values: { 阵营: '正道' },
      });
      expect(updated.ok, JSON.stringify(updated)).toBe(true);
      if (!updated.ok) return;
      expect(updated.revision).not.toBe(submitted.revision);

      const body = state.getSnapshot();
      expect(body.settingsEntities[0]?.name).toBe('太虚剑宗（改名）');
      expect(body.settingsEntities[0]?.values).toEqual({ 阵营: '正道' });

      // 库里确实只有一条，且 revision_seq 走到了 2。
      expect(
        inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM settings_entities WHERE name = ?').get('太虚剑宗（改名）')),
      ).toEqual({ n: 1 });
      expect(
        inspect((db) => db.prepare('SELECT revision_seq AS n FROM settings_entities WHERE id = ?').get(submitted.entityId)),
      ).toEqual({ n: 2 });

      // 过期 revision：状态机把脱敏错误码写进 lastError，界面可提示「重新加载」。
      const conflicting = await state.submitSettingsEntity({
        entityId: submitted.entityId,
        schemaTemplateId: TEMPLATE,
        name: '基于旧版本改名',
        values: { 阵营: '正道' },
        expectedRevision: submitted.revision,
      });
      expect(conflicting.ok).toBe(false);
      expect(conflicting.ok === false && conflicting.code).toBe('REVISION_CONFLICT');
      expect(state.getSnapshot().lastError?.code).toBe('REVISION_CONFLICT');
    } finally {
      state.dispose();
    }
  });
});
