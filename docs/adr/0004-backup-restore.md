# ADR 0004：恢复点与工作区导出（一致快照 + 清单 + 严格校验 + 原子恢复）

- 状态：已接受（P1-A4 / task-11，Lead）
- 代码：`packages/persistence-sqlite/src/export/{manifest,fsErrors,backup,restore,index}.ts`
- 测试：`packages/persistence-sqlite/tests/export/{helpers,manifest,backup,restore}.test.ts`
- 相关风险：R-25（真实文件库才走到的分支必须用真实文件库测）、R-28（备份集暂不含附件二进制）

## 背景与判据

设计文档给的硬要求（逐条在代码注释里标注了出处）：

| 判据 | 原文要点 |
| --- | --- |
| `06-数据与本地存储.md:49` | 备份用 SQLite 在线备份机制或停服一致复制，**禁止只复制主文件而遗漏活动 WAL** |
| `06-数据与本地存储.md:69` | 迁移前创建一致备份；库比程序新时**拒绝写入**并提供兼容导出/恢复指引 |
| `06-数据与本地存储.md:73` | 恢复点包含库版本、同步协议、插件数据版本、附件清单与校验；**先在隔离目录验证再切换服务**；独立备份保留误删前版本，同步不是备份 |
| `09-部署与运维.md:99` | 备份集包含一致数据库、所引用附件、配置、插件包清单与密钥恢复说明；秘密另行受控保存；备份需可恢复到**全新实例**并比较正文/引用/摘要 |
| `11-测试验收与迁移.md:44` | 秘密不能出现在日志、普通导出、同步包和错误堆栈 |
| `11-测试验收与迁移.md:48` | 备份恢复必须在新实例完成正文/引用/附件校验，**不能只验证备份文件存在** |

## 决策

### D1：快照用 `VACUUM INTO`，不复用 `createConsistentBackup`

`migrator.ts` 已导出 `createConsistentBackup`（同样用 `VACUUM INTO`），但它会自行加时间戳后缀、且语义是"迁移前保命"。
导出是**用户可见的产物**（路径由输入决定、可指定清单位置），因此 `backup.ts` 自己执行 `VACUUM INTO ?`，并额外做三件事：

1. 目标/清单**已存在即拒绝**（`ALREADY_EXISTS`）——备份绝不能被"顺手"覆盖掉；
2. 写完立刻用**只读**连接打开快照，跑 `PRAGMA integrity_check` 并核对 17 张逻辑表 + `schema_migrations` 齐全；
3. **清单从快照自己的连接读取**（不是从源库），避免导出期间源库继续写入导致"清单说 A、文件是 B"。

### D2：清单是"可被机器严格拒绝"的契约，不是注释

`parseBackupManifest` 采取白名单式严格解析：

- 非对象、缺字段、类型不符 → `STORAGE_CORRUPT`，且 `detail.field` 指到具体字段（便于定位与用户提示）；
- `manifestVersion > BACKUP_MANIFEST_VERSION` → `STORAGE_SCHEMA_TOO_NEW`（不猜字段语义）；
- `containsSecrets !== false`、`attachmentFilesIncluded !== false` → `STORAGE_CORRUPT`。

最后一条是**故意让清单在结构上无法撒谎**：当前实现不搬运附件二进制（R-28），所以清单里只允许写 `false`。将来真把附件纳入备份集，必须先改清单结构再改这个断言——避免"文档写包含、实现没包含"这种只有用户会踩的坑。

清单只记 `fileName`（`basename`），**绝不记绝对路径**：导出文件会被拷到别的机器/别的工作区，泄漏本机目录结构既不必要也不安全。

### D3：校验失败一律报错，绝不当成空库

`verifyBackup` 逐项校验：存在性 → 清单可解析 → 字节数 → SHA-256 → 只读打开 + `integrity_check` → 必需表齐全 → 库版本与清单一致 → `checkSchemaCompat` → 迁移台账（**版本 + 校验和**都比）→ 实体计数逐项 → 工作区归属 → 附件元数据清单。

- 只有这样，`11:48`「不能只验证备份文件存在」才被真正满足；
- 把损坏备份当空库恢复，用户拿到的是一个**空工作区**——比报错严重得多；
- 迁移台账比对必须带 `checksum`：只比版本号会漏掉"迁移内容被改过"。

版本过高的出路是"升级程序后重试，或用新版本导出兼容副本"（`STORAGE_SCHEMA_TOO_NEW` 是 `critical`），而不是尽力打开：`checkSchemaCompat(found > expected)` 定义为 `'too-new'`，与契约 `version.ts` 的注释一致。

### D4：恢复 = 先验证 → 暂存副本 → 再验证 → 原子换名 → 再验证

```
verifyBackup(源)        ← 失败：目标一动不动
  → copyFile 到 <target>.restoring
  → verifyBackup(副本)  ← 失败：删临时文件，目标不改动（抓"磁盘满导致半截复制"）
  → rmSync(target) + renameSync(副本, target)   ← Windows 上 rename 不能覆盖已存在文件
  → verifyBackup(目标)  ← 失败：删除目标（避免用户误用坏库）
```

「失败不留损坏目标」是这条流水线的唯一目的：每一步失败都只清理自己写出的东西。

### D5：FS 错误映射表**不映射** `ENOENT`

同一个 `ENOENT` 在"读快照"时是 `NOT_FOUND_SNAPSHOT`，在"写清单时目录不存在"时是 `STORAGE_UNAVAILABLE`。
统一成一个码会让"备份目标目录不存在"被报成"快照不存在"，把运维指引带偏。因此映射表只放含义单一的 errno，存在性检查由调用方自己做 `existsSync` 并给精确错误码。

`reasonOf()` 会把 `C:\...`/`/...` 折成 `<path>` 并截断 300 字符，防止把本机路径写进错误载荷（`11:44`）。

## 已知残留（见 R-28）

当前 `attachmentFilesIncluded` 恒为 `false`：`manifest.assets` 只描述"这个备份引用了哪些附件、摘要是什么"，**不搬运 blob**。
附件存储层落地后必须：
1. 把所引用文件一并写入备份集（含每文件 SHA-256 与字节数）；
2. 把 `attachmentFilesIncluded` 放开为 `true`，并让 `verifyBackup` 逐文件校验；
3. 补一条"备份集缺附件文件 → 校验失败"的用例。

在此之前，用户文档必须写明"整库备份不含附件文件，附件需另行备份"。

## 测试取向

- **一律真实文件库**（`tests/export/helpers.ts` 的 `openMigratedDatabase`），不用 `:memory:`——R-25 的教训；
- 读回一律 `openExistingDatabase`（只读 + `fileMustExist`），**禁止"打不开就静默建空库"**把空恢复当通过；
- 必测：WAL 里的最新写入必须进快照（断言 `-wal` 存在且 > 0，快照无 `-wal` 兄弟文件）、往返无损、目标已存在拒绝覆盖、篡改一字节、截断、缺表、清单缺字段/非法 JSON、版本过高、失败后无残留。
