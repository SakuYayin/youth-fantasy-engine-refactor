/**
 * 桌面端到端集成测试：项目管理页（旧版 ProjectHub）与备份/恢复链。
 *
 * 链路：IPC → db-worker → `@yfe/application` 用例 → `@yfe/persistence-sqlite`
 * （repositories / export 层）→ **真实落库 + 真实文件系统**。
 *
 * 只有真链路才能钉住的六件事（每条都对应一个具体的数据损坏风险）：
 *
 * 1. **作品只在自己的工作区可见**：跨工作区的作品绝不能出现在列表里。
 * 2. **重命名的乐观锁真是 CAS**：过期 `expectedRevision` 必须 `REVISION_CONFLICT`，
 *    而且**行不变**（报错了却写进去 = 静默覆盖别人的修改）。
 * 3. **软删不级联**：删作品只标记作品行（子文档行仍在），重复删除报 `NOT_FOUND_PROJECT`，
 *    且从默认列表里消失。
 * 4. 🔴 **备份必须含活动 WAL 里的已提交行**：`VACUUM INTO` 是唯一正确做法——
 *    只复制主文件会丢掉最近写入（这些行还躺在 `-wal` 里没回写）。
 *    这里用「刚提交的一批作品行 → 立刻备份 → 逐行比对快照与源库」来证明。
 * 5. **渲染层读不到备份目录以外的文件**：越界路径必须 `PERMISSION_DENIED`，
 *    而不是「文件不存在」这种可以继续探测的软失败。
 * 6. **恢复绝不碰在用的库**：恢复结果落在 `restore-preview/`，恢复之后当前连接
 *    仍可正常读写（覆盖正在使用的库文件 + WAL 兄弟文件必然损坏数据）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceHost, type ServiceHost } from '../src/main/service-host.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HERE, '..', 'src', 'main', 'db-worker.mjs');
const BACKUP_DIR = 'backups';
const RESTORE_DIR = 'restore-preview';

let tmpRoot = '';
let dbPath = '';
let host: ServiceHost;

interface CallOk {
  readonly ok: true;
  readonly value: unknown;
}
interface CallErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly detail?: Record<string, unknown> };
}

/** 每次请求都用新 requestId（用例层用它做错误关联与幂等键归属）。 */
function readContext(workspaceId: string): Record<string, unknown> {
  return { requestId: `req_${randomUUID()}`, workspaceId };
}

/** 写上下文：`projectId` / `expectedRevision` 显式写出来（null = 不限定 / 不校验）。 */
function writeContext(
  workspaceId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: `req_${randomUUID()}`,
    workspaceId,
    projectId: null,
    expectedRevision: null,
    ...extra,
  };
}

/** 调用并断言成功，返回 value（失败时把完整载荷打进断言消息，便于定位）。 */
async function callOk(method: string, payload: unknown): Promise<unknown> {
  const result = (await host.call(method, payload)) as CallOk | CallErr;
  expect(result.ok, `${method} 应当成功：${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(`${method} 失败`);
  return result.value;
}

/** 把 `host.call` 的未知错误载荷收窄成可断言的形状（`error` 是 unknown，不能直接点字段）。 */
function errorOf(result: unknown): { code: string; detail: Record<string, unknown> } {
  const record = result as { error?: { code?: unknown; detail?: unknown } } | null;
  const error = record?.error;
  return {
    code: typeof error?.code === 'string' ? error.code : '<无错误码>',
    detail: (error?.detail ?? {}) as Record<string, unknown>,
  };
}

/** 调用并断言失败，返回错误码与 detail。 */
async function callErr(
  method: string,
  payload: unknown,
): Promise<{ code: string; detail: Record<string, unknown> }> {
  const result = (await host.call(method, payload)) as CallOk | CallErr;
  expect(result.ok, `${method} 应当失败：${JSON.stringify(result)}`).toBe(false);
  if (result.ok) throw new Error(`${method} 意外成功`);
  return { code: result.error.code, detail: result.error.detail ?? {} };
}

async function createProject(workspaceId: string, name: string): Promise<string> {
  const value = (await callOk('createProject', {
    context: readContext(workspaceId),
    name,
  })) as Record<string, unknown>;
  const projectId = value['projectId'];
  expect(typeof projectId).toBe('string');
  return projectId as string;
}

interface ProjectRow {
  id: string;
  name: string;
  revision: string;
  workspaceId: string;
}

/** 列表项形状（契约是 `BackupEntry`；测试里手写一份，防止契约改动被静默吞掉）。 */
interface BackupListEntry {
  backupPath: string;
  manifestPath: string;
  label: string;
  createdAt: string | null;
  byteSize: number;
  readable: boolean;
}

async function listProjects(workspaceId: string): Promise<ProjectRow[]> {
  const value = (await callOk('listProjects', { context: readContext(workspaceId) })) as {
    projects: ProjectRow[];
  };
  expect(Array.isArray(value.projects)).toBe(true);
  return value.projects;
}

/** 以只读连接读源库（WAL 允许并发读者；worker 仍独占写连接）。 */
function withReadonlyDb<T>(run: (db: InstanceType<typeof Database>) => T): T {
  const inspection = new Database(dbPath, { readonly: true });
  try {
    return run(inspection);
  } finally {
    inspection.close();
  }
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yfe-project-hub-'));
  dbPath = join(tmpRoot, 'project-hub.db');
  host = createServiceHost({ workerPath: WORKER_PATH });
  await host.start();
  const opened = await host.open(dbPath);
  expect(opened.ok, `open 失败：${JSON.stringify(opened)}`).toBe(true);
});

afterAll(async () => {
  await host.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('项目管理页：列表 / 重命名 / 软删', () => {
  it('列表只含本工作区的作品，字段是契约形状', async () => {
    const ws = 'ws_hub_list';
    const other = 'ws_hub_list_other';
    const first = await createProject(ws, '甲作品');
    const second = await createProject(ws, '乙作品');
    await createProject(other, '别人的作品');

    const rows = await listProjects(ws);
    expect(rows.map((row) => row.id).sort()).toEqual([first, second].sort());
    expect(rows.map((row) => row.name).sort()).toEqual(['乙作品', '甲作品']);
    for (const row of rows) {
      expect(row.workspaceId).toBe(ws);
      expect(typeof row.revision).toBe('string');
      expect(row.revision.length).toBeGreaterThan(0);
    }
    // 跨工作区不泄漏：别的作品一条都不许出现
    expect(rows.some((row) => row.name === '别人的作品')).toBe(false);
  });

  it('重命名推进 revision 并反映到列表；同名重命名不推进 revision', async () => {
    const ws = 'ws_hub_rename';
    const projectId = await createProject(ws, '旧名');
    const before = (await listProjects(ws)).find((row) => row.id === projectId);
    expect(before).toBeDefined();

    const renamed = (await callOk('updateProject', {
      context: writeContext(ws, {
        projectId,
        expectedRevision: before?.revision ?? null,
        // 🔴 幂等键必须过全仓 ID 规则 `^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$`：冒号会被拒。
        idempotencyKey: `rename-${projectId}`,
      }),
      projectId,
      name: '新名',
    })) as Record<string, unknown>;
    expect(renamed['projectId']).toBe(projectId);
    expect(typeof renamed['revision']).toBe('string');
    expect(renamed['revision']).not.toBe(before?.revision);

    const after = (await listProjects(ws)).find((row) => row.id === projectId);
    expect(after?.name).toBe('新名');
    expect(after?.revision).toBe(renamed['revision']);

    // 同名重命名：revision 不动（无变化的写不该让别的编辑器吃 REVISION_CONFLICT）
    const same = (await callOk('updateProject', {
      context: writeContext(ws, {
        projectId,
        expectedRevision: after?.revision ?? null,
        idempotencyKey: `rename-same-${projectId}`,
      }),
      projectId,
      name: '新名',
    })) as Record<string, unknown>;
    expect(same['revision']).toBe(after?.revision);
  });

  it('过期 expectedRevision 报 REVISION_CONFLICT，且库里的名字不变', async () => {
    const ws = 'ws_hub_cas';
    const projectId = await createProject(ws, 'CAS 原名');
    const stale = (await listProjects(ws)).find((row) => row.id === projectId)?.revision ?? '';
    // 抢先改一次，让 stale 变成过期版本
    await callOk('updateProject', {
      context: writeContext(ws, { projectId, expectedRevision: stale }),
      projectId,
      name: 'CAS 先改',
    });

    const conflicted = await callErr('updateProject', {
      context: writeContext(ws, { projectId, expectedRevision: stale }),
      projectId,
      name: 'CAS 后改',
    });
    expect(conflicted.code).toBe('REVISION_CONFLICT');
    expect((await listProjects(ws)).find((row) => row.id === projectId)?.name).toBe('CAS 先改');
  });

  it('软删作品：从列表消失、子文档仍在、重复删除报 NOT_FOUND_PROJECT', async () => {
    const ws = 'ws_hub_delete';
    const projectId = await createProject(ws, '待删作品');
    const revision = (await listProjects(ws)).find((row) => row.id === projectId)?.revision ?? '';
    const documentValue = (await callOk('createDocument', {
      context: writeContext(ws, { projectId }),
      projectId,
      kind: 'chapter',
      parentId: null,
      title: '删作品前先建的一章',
      placement: { mode: 'end' },
    })) as Record<string, unknown>;
    const documentId = documentValue['documentId'] as string;

    const deleted = (await callOk('deleteProject', {
      context: writeContext(ws, { projectId, expectedRevision: revision }),
      projectId,
    })) as Record<string, unknown>;
    expect(deleted['projectId']).toBe(projectId);
    expect((await listProjects(ws)).some((row) => row.id === projectId)).toBe(false);

    // 🔴 不级联：作品被软删后子文档行仍在（恢复作品才可能）
    const documentRow = withReadonlyDb((db) =>
      db.prepare('SELECT deleted FROM documents WHERE id = ?').get(documentId),
    ) as { deleted: number } | undefined;
    expect(documentRow?.deleted).toBe(0);

    const again = await callErr('deleteProject', {
      context: writeContext(ws, { projectId }),
      projectId,
    });
    expect(again.code).toBe('NOT_FOUND_PROJECT');
  });

  it('跨工作区重命名报 PERMISSION_WORKSPACE_MISMATCH，绝不伪装成 404', async () => {
    const owner = 'ws_hub_owner';
    const intruder = 'ws_hub_intruder';
    const projectId = await createProject(owner, '别人的作品');

    const denied = await callErr('updateProject', {
      context: writeContext(intruder, { projectId }),
      projectId,
      name: '我改你的',
    });
    expect(denied.code).toBe('PERMISSION_WORKSPACE_MISMATCH');
    expect((await listProjects(owner)).find((row) => row.id === projectId)?.name).toBe('别人的作品');
  });
});

describe('备份与恢复：真实文件系统链路', () => {
  it('🔴 首次开库会留下无清单的迁移前快照：列表不隐藏它，但标记 readable=false', async () => {
    // 这条钉住一个**真实且容易误解**的行为：`migrate()` 在 v0→v1 之前会自动备份到这个目录
    // （`migrator.ts` 的 `createConsistentBackup`），但它**不写清单**（清单只有 export 层会写）。
    // 于是备份管理页会看到一个 readable=false 的项——它不是损坏的备份，是迁移自动快照。
    // 用独立 host + 全新路径，才能观察到「目录从无到有」的完整过程。
    const freshRoot = mkdtempSync(join(tmpdir(), 'yfe-migration-snapshot-'));
    const freshDbPath = join(freshRoot, 'migration-probe.db');
    const freshBackupDir = join(freshRoot, BACKUP_DIR);
    const freshHost = createServiceHost({ workerPath: WORKER_PATH });
    await freshHost.start();
    try {
      expect(existsSync(freshBackupDir), '开库之前不该有备份目录').toBe(false);

      // 🔴 未开库时**必须明确拒绝**，不能返回空数组：空数组会让界面显示「还没有备份」，
      //    而真相是「备份功能现在不可用」。这两种状态对用户完全不同。
      const tooEarly = await freshHost.call('backupList', null);
      expect(tooEarly.ok, JSON.stringify(tooEarly)).toBe(false);
      if (!tooEarly.ok) expect(errorOf(tooEarly).code).toBe('STATE_INVALID_TRANSITION');
      expect(existsSync(freshBackupDir), '被拒绝的调用不该顺手建目录').toBe(false);

      const opened = await freshHost.open(freshDbPath);
      expect(opened.ok, JSON.stringify(opened)).toBe(true);

      const listed = await freshHost.call('backupList', null);
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) throw new Error('backupList 失败');
      const entries = (listed.value as { backups: BackupListEntry[] }).backups;
      expect(entries.length, '首次迁移应当留下恰好一份迁移前快照').toBe(1);
      const [snapshot] = entries;
      expect(snapshot?.readable).toBe(false);
      expect(snapshot?.createdAt).toBeNull();
      expect(snapshot?.byteSize).toBeGreaterThan(0);
      expect(snapshot?.backupPath.startsWith(freshBackupDir)).toBe(true);
      // 文件名是可辨识的迁移快照形态（`<库名>.v<旧版本>.<时间戳>.db`）
      expect(snapshot?.label).toMatch(/^migration-probe\.v\d+\./);

      // 🔴 缺清单 ⇒ 不能作为恢复点：verify 明确报 NOT_FOUND_SNAPSHOT，
      //    而不是「integrity ok」让用户以为它能恢复。
      const verified = await freshHost.call('backupVerify', { backupPath: snapshot?.backupPath });
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(errorOf(verified).code).toBe('NOT_FOUND_SNAPSHOT');
    } finally {
      await freshHost.shutdown();
    }

    // 「已开库 + 备份目录确实不存在」= 正常空态：库已是最新（无迁移）且用户删过备份目录。
    // 只有这条路径允许返回空数组，必须与上面的「未开库拒绝」区分开。
    rmSync(freshBackupDir, { recursive: true, force: true });
    const reopenedHost = createServiceHost({ workerPath: WORKER_PATH });
    await reopenedHost.start();
    try {
      const reopened = await reopenedHost.open(freshDbPath);
      expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
      expect(existsSync(freshBackupDir), '没有待应用迁移就不该再建备份目录').toBe(false);
      const empty = await reopenedHost.call('backupList', null);
      expect(empty.ok, JSON.stringify(empty)).toBe(true);
      if (empty.ok) expect((empty.value as { backups: unknown[] }).backups).toEqual([]);
    } finally {
      await reopenedHost.shutdown();
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });

  it('🔴 备份含活动 WAL 里的已提交行：快照与源库逐行一致', async () => {
    const ws = 'ws_backup_wal';
    // 先造一批行并立刻备份：这批行刚提交，基本都还躺在 -wal 里没 checkpoint 回主文件。
    // 「只复制主文件」的实现会在这里少行；VACUUM INTO 不会。
    const expected = new Map<string, string>();
    for (let index = 0; index < 60; index += 1) {
      const name = `WAL${String(index).padStart(3, '0')}`;
      expected.set(await createProject(ws, name), name);
    }

    const created = (await callOk('backupCreate', { label: 'WAL 快照' })) as Record<string, unknown>;
    const backupPath = created['backupPath'] as string;
    const manifestPath = created['manifestPath'] as string;
    expect(typeof backupPath).toBe('string');
    expect(existsSync(backupPath), `快照应当落盘：${backupPath}`).toBe(true);
    expect(existsSync(manifestPath), `清单应当与快照成对写出：${manifestPath}`).toBe(true);
    expect(created['byteSize']).toBeGreaterThan(0);
    expect(typeof created['durationMs']).toBe('number');
    // 快照必须落在备份目录内（渲染层拿到的路径不能跑到别处）
    expect(backupPath.startsWith(join(tmpRoot, BACKUP_DIR))).toBe(true);

    const source = withReadonlyDb((db) =>
      db.prepare('SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY id').all(ws),
    ) as { id: string; name: string }[];
    expect(source).toHaveLength(60);

    const snapshot = new Database(backupPath, { readonly: true });
    let snapshotRows: { id: string; name: string }[];
    try {
      snapshotRows = snapshot
        .prepare('SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY id')
        .all(ws) as { id: string; name: string }[];
      // 快照是完整数据库（不是半成品）：完整性自检必须通过
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      snapshot.close();
    }
    expect(snapshotRows).toHaveLength(source.length);
    for (const row of snapshotRows) {
      expect(expected.get(row.id)).toBe(row.name);
    }
    // 快照是单文件：绝不能自带 -wal 兄弟文件（否则恢复会丢那部分数据）
    expect(existsSync(`${backupPath}-wal`)).toBe(false);
  });

  it('校验：正常备份 integrity ok；文件名不在备份目录内报 PERMISSION_DENIED', async () => {
    const created = (await callOk('backupCreate', { label: '校验用' })) as Record<string, unknown>;
    const backupPath = created['backupPath'] as string;

    const verified = (await callOk('backupVerify', { backupPath })) as Record<string, unknown>;
    expect(verified['integrity']).toBe('ok');
    expect(verified['backupPath']).toBe(backupPath);
    expect(verified['databaseSchemaVersion']).toBeGreaterThan(0);
    expect(verified['needsMigration']).toBe(false);
    expect(verified['byteSize']).toBeGreaterThan(0);

    // 越界：渲染层不能借 IPC 读任意文件（这里是库文件本身，最有诱惑力的目标）
    const escape = await callErr('backupVerify', { backupPath: dbPath });
    expect(escape.code).toBe('PERMISSION_DENIED');
    expect(escape.detail['reason']).toBe('outside_backup_dir');

    // `..` 逃逸同样被规范化后挡住
    const traversal = await callErr('backupVerify', {
      backupPath: join(tmpRoot, BACKUP_DIR, '..', '..', 'etc', 'passwd'),
    });
    expect(traversal.code).toBe('PERMISSION_DENIED');

    // 目录内的不存在文件：只读失败 → NOT_FOUND_SNAPSHOT
    const missing = await callErr('backupVerify', {
      backupPath: join(tmpRoot, BACKUP_DIR, `不存在-${randomUUID()}.db`),
    });
    expect(missing.code).toBe('NOT_FOUND_SNAPSHOT');
  });

  it('列表：损坏项（缺清单）仍列出但标 readable=false，正常项 readable=true', async () => {
    const created = (await callOk('backupCreate', { label: '列表用正常' })) as Record<string, unknown>;
    const backupPath = created['backupPath'] as string;

    // 手工复制一份快照但**不复制清单**：模拟「备份文件还在、清单丢了」
    const orphanPath = join(tmpRoot, BACKUP_DIR, `孤儿-${randomUUID()}.db`);
    copyFileSync(backupPath, orphanPath);

    const value = (await callOk('backupList', null)) as {
      backups: { backupPath: string; readable: boolean; createdAt: string | null; byteSize: number }[];
    };
    const list = value.backups;
    expect(list.length).toBeGreaterThanOrEqual(2);

    const good = list.find((entry) => entry.backupPath === backupPath);
    expect(good, '正常备份必须出现在列表里').toBeDefined();
    expect(good?.readable).toBe(true);
    expect(good?.createdAt).not.toBeNull();
    expect(good?.byteSize).toBeGreaterThan(0);

    const orphan = list.find((entry) => entry.backupPath === orphanPath);
    expect(orphan, '🔴 清单丢失的备份不许凭空消失').toBeDefined();
    expect(orphan?.readable).toBe(false);
    expect(orphan?.createdAt).toBeNull();
    // 清单文件本身（.manifest.json）不应作为独立项出现
    expect(list.some((entry) => entry.backupPath.endsWith('.manifest.json'))).toBe(false);
  });

  it('🔴 恢复写到 restore-preview，绝不覆盖在用的库；覆盖同名需显式 overwrite', async () => {
    const ws = 'ws_backup_restore';
    const kept = await createProject(ws, '恢复前就有的作品');
    const created = (await callOk('backupCreate', { label: '恢复用' })) as Record<string, unknown>;
    const backupPath = created['backupPath'] as string;

    // 备份之后又写了新数据：恢复**不得**回退当前库（预览版只产出候选文件）
    const later = await createProject(ws, '备份之后才写的作品');
    const beforeCount = withReadonlyDb(
      (db) =>
        (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
    );

    const restored = (await callOk('backupRestore', { backupPath })) as Record<string, unknown>;
    const targetPath = restored['targetPath'] as string;
    expect(restored['verified']).toBe(true);
    expect(targetPath).not.toBe(dbPath);
    expect(targetPath.startsWith(join(tmpRoot, RESTORE_DIR))).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
    expect(existsSync(restored['manifestPath'] as string)).toBe(true);

    // 恢复产物本身可校验：它是一份能打开的完整库
    const restoredDb = new Database(targetPath, { readonly: true });
    try {
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restoredDb.close();
    }

    // 当前库一行都没少：仍然能读到「备份之后才写的作品」
    expect(withReadonlyDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n)).toBe(
      beforeCount,
    );
    const rows = await listProjects(ws);
    expect(rows.map((row) => row.id).sort()).toEqual([kept, later].sort());
    // 恢复目标不是当前库 ⇒ 在用连接不受伤
    expect(statSync(dbPath).isFile()).toBe(true);

    // 同源再恢复一次：目标已存在 ⇒ ALREADY_EXISTS（覆盖必须显式）
    const again = await callErr('backupRestore', { backupPath });
    expect(again.code).toBe('ALREADY_EXISTS');
    const forced = (await callOk('backupRestore', { backupPath, overwrite: true })) as Record<
      string,
      unknown
    >;
    expect(forced['targetPath']).toBe(targetPath);

    // 恢复目录里只有一个候选文件（不会每恢复一次就堆一个随机名）
    const candidates = readdirSync(join(tmpRoot, RESTORE_DIR)).filter((name) => name.endsWith('.db'));
    expect(candidates).toHaveLength(1);
  });

  it('库未打开时四个备份方法报 STATE_INVALID_TRANSITION，且 worker 依然能开库', async () => {
    // 用一个**独立**的 worker + 独立目录：本文件的 host 已经开过库，测不出「未打开」这条路径；
    // 独立目录才能让「列表里有什么」只反映这个 worker 自己的动作。
    const freshRoot = mkdtempSync(join(tmpdir(), 'yfe-unopened-probe-'));
    const freshHost = createServiceHost({ workerPath: WORKER_PATH });
    await freshHost.start();
    try {
      const probes: [string, unknown][] = [
        ['backupCreate', { label: '未开库' }],
        ['backupList', null],
        ['backupVerify', { backupPath: join(freshRoot, BACKUP_DIR, 'x.db') }],
        ['backupRestore', { backupPath: join(freshRoot, BACKUP_DIR, 'x.db') }],
      ];
      for (const [method, payload] of probes) {
        const result = await freshHost.call(method, payload);
        expect(result.ok, `${method} 在未开库时必须失败，而不是崩掉 worker`).toBe(false);
        // 🔴 必须是可辨识的状态错误：不能是 SERVICE_UNAVAILABLE（掩盖真实原因），
        //    也不能是 INTERNAL_ERROR（说明是未捕获异常穿透了请求循环）。
        if (!result.ok) expect(result.error.code).toBe('STATE_INVALID_TRANSITION');
      }

      // worker 没死：紧接着开库，并立刻能列出这个目录自己的迁移前快照
      const freshDbPath = join(freshRoot, 'unopened-probe.db');
      const opened = await freshHost.open(freshDbPath);
      expect(opened.ok, `未开库的探测之后仍应能开库：${JSON.stringify(opened)}`).toBe(true);
      const listed = await freshHost.call('backupList', null);
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (listed.ok) {
        const entries = (listed.value as { backups: { backupPath: string }[] }).backups;
        expect(entries.length).toBe(1);
        expect(entries[0]?.backupPath.startsWith(join(freshRoot, BACKUP_DIR))).toBe(true);
      }
    } finally {
      await freshHost.shutdown();
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

