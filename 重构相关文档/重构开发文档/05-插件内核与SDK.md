# 插件内核与 SDK 设计

## 内核选择和边界

采用 Cordis 管理服务依赖、事件和可撤销注册；产品自己的 SDK 管理 Manifest、能力授权、数据、贡献点、兼容与升级。Electron 提供运行环境，CodeMirror 提供编辑器扩展，两者都不代替插件内核。

Cordis 上游当前明确标注 API 尚不稳定，DSH 还维护固定来源的 vendored 副本，两者不能仅按名称互换。P0 选定可审计来源、精确版本或提交和依赖完整性，锁定后由适配器使用；第三方只导入产品 SDK，不导入 Cordis 或 DSH 私有类型。上游升级作为单独变更，生命周期回归通过后才合入。[上游说明](https://github.com/cordiverse/cordis)、[DSH 固定副本说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)

## 宿主与扩展类型

| 类型 | 执行位置 | 首版开放范围 |
| --- | --- | --- |
| 声明式资源 | 各端解析器 | 用户可导入主题、字段、模板、工作区、有限工作流 |
| 可信 UI 插件 | 桌面 renderer，与服务插件分别装配 | 随发行版提供；面板、菜单、编辑器扩展 |
| 可信服务插件 | local-service 或后端 Cordis Context | 随发行版提供；模型、导入器、协议、处理器 |
| 第三方执行插件 | 独立能力受限执行器 | 完成隔离与资源验证后开放，不直接放进主 Context |
| UTS 原生扩展 | Android APK | 构建时加入，不自动从同步目录加载 |

每个进程维护自己的 Context，不通过 IPC 序列化 Context 对象。SDK 中的服务代理通过消息调用另一宿主能力。renderer 不为插件开放 Node；有本地 Node 权限的服务插件即使运行在单独进程也属于可信代码，权限声明不能自动约束其任意 Node 调用。

## Manifest 草案

以下是产品格式草案，非 Cordis 配置文件，也不是当前已实现的安装包。

```json
{
  "id": "yfe.characters",
  "version": "1.0.0",
  "manifestVersion": 1,
  "hostApiRange": "^1.0.0",
  "kind": "trusted-builtin",
  "platforms": ["desktop", "server"],
  "entries": { "ui": "dist/ui.js", "service": "dist/service.js" },
  "dependencies": { "yfe.project": "^1.0.0" },
  "requiredServices": ["project.read", "settings.write"],
  "permissions": ["project:read", "settings:write"],
  "contributes": { "panels": ["characters"], "commands": ["characters.create"] },
  "configSchema": "schemas/config.json",
  "dataSchemaVersion": 1
}
```

清单校验 ID、版本、宿主范围、平台、依赖、文件路径和贡献点唯一性，禁止路径逃逸与包内符号链接越界。安装包文件清单带摘要、来源与签名信息；签名用于来源和完整性，不等于代码安全认证。插件自身数据使用 (workspaceId, pluginId, key) 命名空间，不能直接访问其他插件的私表。

kind 是格式声明，不是信任授予。trusted-builtin 必须由宿主发行清单和来源验证共同确认，用户包不能通过修改这一字段进入有 Node 权限的可信 Context。权限列表也只是申请，实际授权来自宿主记录。

## SDK 契约

```ts
// 产品接口草案，适配层内部再转换为所锁定 Cordis API。
interface PluginContext {
  identity: { pluginId: string; workspaceId: string };
  services: ServiceResolver;
  contributions: ContributionRegistry;
  config: Readonly<Record<string, unknown>>;
  data: PluginDataRepository;
  effects: { add(dispose: () => void | Promise<void>): void };
}
interface ProductPlugin {
  activate(context: PluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}
```

ServiceResolver、ContributionRegistry 和 PluginDataRepository 在 packages/plugin-sdk 定义稳定类型；这些名字在此为接口位置，不声称已提供实现。服务解析得到按插件身份收窄的能力代理，写操作仍通过事务应用命令。UI 贡献点使用语义 ID，不能随意修改其他插件 DOM。

## 生命周期

安装校验 → 解析依赖图 → 检查授权 → 数据迁移 → 激活服务 → 挂载界面 → 健康确认。缺失依赖、循环、API 不兼容均拒绝激活，展示原因，不自动升级一串包以碰运气。

禁用时先停止新任务并解除 UI 入口，按插件策略排空或取消运行任务，再撤销订阅、命令、计时器、worker 与服务。清理超时或异常进入 failed/quarantined 状态；单独执行器可以终止，宿主内可信插件不可安全强杀时重启服务宿主并从持久状态恢复。

配置变更先校验并生成新版本，支持热更新的插件在边界重载；失败恢复旧配置。带数据库迁移、原生模块或运行中外部任务的升级按维护窗口处理，不承诺所有包即时热替换。

卸载默认保留插件数据，用户单独选择清除；仍被正文引用的资产和模板字段不可直接删除。升级迁移备份后执行，降级必须检测 dataSchemaVersion。同步插件清单只表示用户偏好，目标设备先验证包、平台和授权再启用。

## 主题、模板和编辑器

主题以设计令牌为主：字体、色彩、间距、正文宽度、专注样式。首版外部主题不执行脚本，不允许任意远程 URL；桌面与手机映射同一语义令牌。可信桌面插件可提供受控编辑器装饰与组件。

作品模板包含字段稳定 ID、显示名、结构、校验规则、提示词与版本；不将中文显示名作为永久主键。工作流是有限步骤和已安装能力的组合，禁止任意 JS 表达式或 YAML 执行标签。DSH 的配置执行能力不照搬到用户可导入的资源文件。

编辑器可注册命令、快捷键、装饰、侧栏和 Editor Adapter。任何写正文的扩展必须提交 expectedRevision，不能绕过草稿与采用机制。缺失扩展时仍能用基础编辑器阅读和导出正文。

## 发布门禁

必须验证依赖等待、移除、异常激活回滚、异步清理、重复卸载、热更新失败回退、运行任务中禁用、跨工作区隔离、升级迁移和未知数据保留。连续启停后资源计数与内存回到可解释范围。Cordis 通过这些用例后才进入稳定版。

第三方执行隔离可后续评估 Wasm/Extism 或操作系统能力沙箱。Node vm、Worker、utilityProcess 本身都不等于安全沙箱。开放前验证网络/文件/凭据代理、CPU 与内存限额、终止、审计和 UI 边界；不能为了插件数量降低此门槛。
