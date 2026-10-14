# 同步协议与 API 设计

## 基础约定

协议 v1，HTTP 路径 /api/v1。OpenAPI 与 JSON Schema 是跨端契约来源，TypeScript 客户端生成，UTS/原生端在生成能力不足时用契约样本验证适配。日期 UTC、ID/revision/cursor 为字符串，附件 SHA-256；JSON 编码为 UTF-8。摘要算法与规范化方式版本化，不对任意 JSON.stringify 输出假定跨端字节一致。

服务通过 capabilities 返回 serverId、协议范围、资源上限、附件上传能力、支持命令和模式。客户端协议不兼容时保留本地编辑、停止推送并提示，不能当成空服务重新初始化。

普通错误结构为 code、message、requestId、retryable 与可选 details；不得包含堆栈、正文和秘密。分页使用 cursor/limit。HTTP 401=需认证，403=无权限，409=版本/幂等冲突，410=游标或资源保留期结束，413=超过限制，429=限流，503=暂不可用。客户端按 code 分类而非比较错误中文。

## 首版 API 清单

下表为开发契约草案，不代表当前存在这些接口；P0 需形成可校验 OpenAPI 文件。

| 方法与路径 | 用途 | 权限与结果 |
| --- | --- | --- |
| GET /health/live、/health/ready | 存活/可用，路径在 API 前缀之外 | 最小公开状态，详细诊断需管理员 |
| GET /api/v1/capabilities | 版本与能力 | 不返回内部路径和秘密 |
| POST /api/v1/setup | 一次性初始化 | 引导凭据，初始化后禁用 |
| POST /api/v1/auth/login | 登录 | 限流，Web Cookie 或设备流程 |
| POST /api/v1/auth/refresh、/auth/logout | 刷新与退出 | 轮换、撤销与 Web CSRF |
| GET /api/v1/users/me | 当前身份 | 已认证 |
| GET/POST /api/v1/admin/users | 用户列表/创建 | 管理员 |
| PATCH /api/v1/admin/users/{id} | 停用/更新用户 | 管理员，防止误禁用最后管理员 |
| POST /api/v1/admin/users/{id}/password-reset | 管理员重置流程 | 限时凭据，不返回旧密码 |
| GET/POST /api/v1/workspaces | 列举/创建 | 已认证与创建策略 |
| GET/PUT/DELETE /api/v1/workspaces/{id}/members/{userId} | 成员与角色 | 所有者；最后所有者不可误删 |
| POST /api/v1/pairing-codes | 创建短期配对码 | 授权用户 |
| POST /api/v1/devices/pair | 消耗配对码 | 一次性、尝试次数限制 |
| GET /api/v1/devices、DELETE /devices/{id} | 列表/撤销 | 本人或有管理权限的主体 |
| GET /api/v1/workspaces/{id}/snapshot | 一致快照与 cursor | 工作区读取权限 |
| GET /api/v1/workspaces/{id}/changes | 游标增量 | 工作区读取权限，过期返回 410 |
| POST /api/v1/workspaces/{id}/batches | 原子变更提交 | 工作区写权限，幂等与基线检查 |
| GET /api/v1/workspaces/{id}/receipts/{batchId} | 丢失确认后查结果 | 原提交者或管理者 |
| GET /api/v1/workspaces/{id}/entities/{entityId}/versions | 版本历史 | 资源读取权限 |
| GET /api/v1/workspaces/{id}/config、/plugin-state | 只读配置投影 | 写入统一走 batches |
| POST /api/v1/workspaces/{id}/uploads | 建立附件上传 | 配额、大小、摘要 |
| PUT /api/v1/uploads/{uploadId}/parts/{part} | 上传块 | 上传会话的主体与工作区 |
| POST /api/v1/uploads/{uploadId}/complete | 校验与发布对象 | 返回 assetId，不自动创建正文引用 |
| GET /api/v1/workspaces/{id}/assets/{assetId} | 下载 | 验证引用与权限，不仅凭摘要 |
| POST/GET /api/v1/workspaces/{id}/jobs | 创建/查询任务 | 资源、执行器与预算检查 |
| GET /api/v1/jobs/{id}、POST /jobs/{id}/cancel | 状态/取消 | 任务权限；不承诺撤销外部计费 |
| POST /api/v1/devices/{id}/commands | 远程命令 | 命令白名单、目标设备授权 |
| POST /api/v1/devices/{id}/commands/claim | 设备领取命令 | 设备自身，事务租约 |
| POST /api/v1/commands/{id}/ack | 命令进度与回执 | 被指定执行器 |
| GET /api/v1/events | SSE 通知 | 认证且按工作区过滤；支持状态轮询退路 |
| GET/POST /api/v1/admin/storage | 存储列表/创建 | 管理员，秘密只写引用 |
| PATCH/DELETE /api/v1/admin/storage/{id} | 更新/移除存储 | 管理员，被引用存储不得直接移除 |
| POST /api/v1/admin/storage/{id}/probe | 非破坏能力探测 | 管理员与指定根范围 |
| GET/POST /api/v1/admin/backups | 备份列表/发起 | 管理员 |
| POST /api/v1/admin/backups/{id}/verify | 验证恢复集 | 管理员，异步任务返回 jobId |
| POST /api/v1/admin/backups/{id}/restore | 维护模式恢复 | 管理员二次认证、停止写入、隔离验证 |

表中缩写路径延续 /api/v1 前缀。P0 将接口、请求响应 DTO、错误和权限形成可校验的 OpenAPI；上述设计不是已运行服务。复杂任务事件不塞入同步 change feed，订阅丢失后查询持久任务状态。

## 变更格式与原子性

```json
{
  "protocolVersion": 1,
  "batchId": "uuid-batch",
  "deviceId": "uuid-device",
  "operations": [{
    "opId": "uuid-operation",
    "entityType": "document",
    "entityId": "uuid-document",
    "projectId": "uuid-project",
    "baseRevision": "revision-before",
    "newRevision": "uuid-new-revision",
    "action": "upsert",
    "payload": { "title": "第一章", "body": "正文" },
    "assetIds": []
  }]
}
```

创建实体 baseRevision 为 null；删除使用 action=delete 和基线，生成墓碑。主体、实际 deviceId 与 workspaceId 从路径及认证上下文交叉验证，不能凭 payload 提权。entityType 与 action 有枚举和 Schema，未知类型不静默丢弃。

每批次限定一个工作区，初始上限建议 100 个操作/4 MiB，正文超限拆章或返回可执行提示；附件走独立上传。P0 按样本确定正式上限并由 capabilities 返回，所有客户端遵守。

服务器先检查 batchId/opId 与规范化载荷摘要，再在单个数据库事务中验证权限、引用和每个基线，更新实体、版本、change_feed、幂等回执。**一个批次全部接受或全部拒绝**，首版不设计隐藏的部分成功。任一基线冲突返回 409 和可读取的冲突元数据，不能提前确认其他操作。

成功回执返回 batchId、每个 opId 的 revision 和游标。确认丢失用同一批次重试或查询 receipt；相同 ID 不同载荷返回 IDEMPOTENCY_KEY_REUSED，绝不二次写入。幂等回执的保留策略至少覆盖增量窗口，过期设备必须完整重同步，不能接受未知旧请求并重复执行。

## 离线链与冲突

本地每次保存产生自己的 revision 与 baseRevision。离线连续修改同一实体形成链；推送按依赖顺序，批内后一操作可引用前一操作的新 revision。未确认 outbox 不能仅按最新修改时间合并覆盖。

收到外部变更时，先在本地事务保存远端影子版本和游标。没有本地分支可更新实体；有 outbox 时保留本地稿与共同基线，不把远端内容直接覆盖输入框。

不同实体独立提交；字段三方合并仅对定义过策略的字段生效。正文默认保留双方版本，提供比较与明确采用；能证明不重叠的文本合并作为后续增强。删除对编辑、移动对删除、模板字段变更都进入显式冲突，不使用最后写入者全量覆盖。

用户解决冲突后产生新操作，baseRevision 指向当前远端版本。尚未接受的旧 outbox 链标记 superseded 并保留来源，新操作使用新 opId/batchId，不能复用旧幂等键改载荷。

## 增量、快照与附件

change feed 按服务器提交顺序产生游标，不依赖设备时钟。一次本地事务应用完整批次、保存 revision 和新 cursor，事务失败不推进游标。快照返回固定一致点及该点 cursor；快照后继续拉增量，避免分页期间漏变更。

附件先上传/校验，再提交引用。断点以服务器确认的 part 状态为准；complete 校验整个对象，重复 complete 返回同一结果。GC 等待引用、有效设备游标及保留期，墓碑不因某设备离线而立即消失。

游标过期返回 410/RESYNC_REQUIRED。客户端先保存离线分支，再下载快照并重放或形成冲突，不能清空未同步稿件。重置同步和更换 serverId 是显式操作，保留本地备份。

## 文件共享适配与直连

StorageProvider 只提供 list/read/write/delete/rename/conditionalWrite/checksum 等能力，SyncEngine 负责语义。每个驱动记录实际服务器行为与错误分类。

| 协议 | 桌面/后端 | 手机 | 首版顺序 |
| --- | --- | --- | --- |
| 本地/挂载目录 | 原生文件 API，受根目录限制 | 系统文件选择与缓存 | 核心 |
| WebDAV | 原生 HTTP，验证 ETag/条件写入 | 优先直连扩展 | 第一批 |
| S3 兼容 | SDK，验证签名与条件行为 | 优先后端代理 | 第一批 |
| SMB 2/3 | 系统挂载或按需连接器 | 优先后端代理 | P5 |
| FTP/FTPS | 独立驱动，明文与 TLS 模式区分 | 优先后端代理 | P5 |
| SFTP | SSH 文件驱动，校验主机身份 | 优先后端代理 | P5 |
| NFS | 宿主机挂载后绑定目录 | 后端代理，无 root 要求 | P5 |
| DLNA | 可选媒体浏览插件 | 可选 | 不做配置同步 |

候选 rclone 按需使用，权限、取消、版本和包体纳入验收。它的 sync 命令不承担产品的版本冲突协议，不可直接拿双向覆盖命令同步活数据库。[官方协议列表](https://rclone.org/)

直连文件模式使用每个设备/写会话独立的不可变批次对象、摘要和完整提交标记。无可靠条件写入的服务，不设置多人争写的单个可变 manifest；对象发布、完整读取、发现和恢复都要实测。读取半成品只重试，不能视为空库。若驱动无法保证可恢复发现与发布，先开放备份/素材访问，双向同步走后端。

直连日志保留原始操作，使用同一基线规则检测分支；检查点压缩与 GC 在设备确认机制验证前禁用。首次为空须由“明确不存在”确认，认证失败、超时或损坏都不能当空。NFS/SMB 只存日志、附件和备份，不共享 SQLite。

错误诊断区分 DNS、网络、TLS、认证、路径、权限、配额、协议不兼容和冲突。连接测试实际验证随机临时对象的写、读、删除和所需条件操作，并清理，不靠浏览器 GET 成功宣称同步就绪。
