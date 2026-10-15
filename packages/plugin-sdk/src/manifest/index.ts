/**
 * 插件 Manifest 契约与校验（`@yfe/plugin-sdk/manifest`）。
 *
 * 设计依据：`05-插件内核与SDK.md`「Manifest 草案」与「校验 ID、版本、宿主范围、平台、
 * 依赖、文件路径、贡献点唯一性；禁止路径逃逸与包内符号链接越界」。
 *
 * 🔴 本模块**不得** import cordis，也不得引用宿主私有类型：第三方插件作者只依赖本包，
 * 一旦把上游类型泄漏到这里，插件就被绑死在 Cordis 的 API 稳定性上（ADR 004/0002）。
 *
 * 🔴 `kind` 是**格式声明**，不是信任授予；`permissions` 只是**申请**，实际授权来自
 * 宿主记录（见 `docs/adr/0002-cordis-lifecycle.md`「能力与安全边界」）。
 */

import { isWellFormedId } from '@yfe/contracts'

/** Manifest 结构版本。结构变更必须递增，并保留旧版迁移路径。 */
export const PLUGIN_MANIFEST_VERSION = 1 as const

/**
 * 本版本允许加载的插件类别。
 *
 * 🔴 只有 `trusted-builtin` 与 `declarative-theme`：ADR 008 明确本版本**只交付内置功能插件、
 * 声明式主题模板和 SDK**，不加载任意第三方代码（无沙箱，见 `PLUGIN_UNGRANTABLE_CAPABILITIES`）。
 */
export const PLUGIN_KINDS = ['trusted-builtin', 'declarative-theme'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

export function isPluginKind(value: unknown): value is PluginKind {
  return typeof value === 'string' && (PLUGIN_KINDS as readonly string[]).includes(value)
}

/** 支持的运行平台。manifest 必须声明非空子集，避免把桌面插件静默装到不支持的平台。 */
export const PLUGIN_PLATFORMS = ['win32', 'darwin', 'linux', 'web', 'mobile'] as const
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number]

export function isPluginPlatform(value: unknown): value is PluginPlatform {
  return typeof value === 'string' && (PLUGIN_PLATFORMS as readonly string[]).includes(value)
}

/**
 * 宿主**可以**授予的能力。
 *
 * 注意：可以授予 ≠ 一定授予。真实授权 = 声明 ∩ 宿主策略（见 `decideCapability`）。
 */
export const PLUGIN_GRANTABLE_CAPABILITIES = [
  'plugin.data.read',
  'plugin.data.write',
  'plugin.events.emit',
  'plugin.events.subscribe',
  'plugin.commands.register',
  'plugin.ui.panel',
  'plugin.tasks.run',
] as const

/**
 * 本版本宿主**无法安全授予**的能力：声明在 manifest 里合法（便于未来兼容与静态分析），
 * 但授权一律拒绝，调用返回 `PERMISSION_PLUGIN_CAPABILITY`。
 *
 * 🔴 依据 ADR 008 原话：「**不能将 Node vm、进程、Worker 当作自动沙箱**；签名也不代表
 * 安全认证」。在没有真实能力隔离之前，宿主**不敢**授予这些能力，也不假装自己隔离了它们。
 */
export const PLUGIN_UNGRANTABLE_CAPABILITIES = [
  'host.filesystem.read',
  'host.filesystem.write',
  'host.network.outbound',
  'host.process.spawn',
  'host.native.addon',
] as const

/** 全部合法能力标识（可授予 + 不可授予），manifest 的 `permissions` 只能取这里的值。 */
export const PLUGIN_CAPABILITIES = [
  ...PLUGIN_GRANTABLE_CAPABILITIES,
  ...PLUGIN_UNGRANTABLE_CAPABILITIES,
] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

export function isPluginCapability(value: unknown): value is PluginCapability {
  return typeof value === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(value)
}

export function isGrantableCapability(value: PluginCapability): boolean {
  return (PLUGIN_GRANTABLE_CAPABILITIES as readonly string[]).includes(value)
}

/** 插件依赖声明：`range` 是 semver 范围，必须被目标插件的 version 满足。 */
export interface PluginDependency {
  readonly id: string
  readonly range: string
}

/** 贡献点声明：只声明 id，实际注册在运行时通过 `ContributionRegistry` 完成。 */
export interface PluginContributionDeclarations {
  readonly panels?: readonly string[]
  readonly commands?: readonly string[]
}

/** 入口文件：相对插件包根的 POSIX 路径，禁止绝对路径与 `..` 逃逸。 */
export interface PluginEntryPoints {
  readonly service?: string
  readonly ui?: string
}

export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly manifestVersion: typeof PLUGIN_MANIFEST_VERSION
  /** 要求的宿主 API 范围，例如 `^1.0.0`。 */
  readonly hostApiRange: string
  readonly kind: PluginKind
  readonly platforms: readonly PluginPlatform[]
  readonly entries: PluginEntryPoints
  readonly dependencies: readonly PluginDependency[]
  /** 需要宿主提供的服务名（服务解析的前置白名单）。 */
  readonly requiredServices: readonly string[]
  /** 申请的能力。只是申请，不等于授权。 */
  readonly permissions: readonly PluginCapability[]
  readonly contributes: PluginContributionDeclarations
  readonly dataSchemaVersion: number
  /** 配置 Schema（JSON Schema 形态）。P0 只校验它是对象。 */
  readonly configSchema?: Readonly<Record<string, unknown>>
}

/** 单条校验失败项。`path` 用 `a.b[0].c` 形态定位，便于直接展示给插件作者。 */
export interface ManifestIssue {
  readonly path: string
  readonly code: ManifestIssueCode
  readonly message: string
}

export type ManifestIssueCode =
  | 'not-an-object'
  | 'missing-field'
  | 'wrong-type'
  | 'malformed-id'
  | 'malformed-version'
  | 'malformed-range'
  | 'manifest-version-unsupported'
  | 'host-api-incompatible'
  | 'unknown-kind'
  | 'unknown-platform'
  | 'empty-list'
  | 'duplicate-entry'
  | 'path-escape'
  | 'out-of-range'
  | 'unknown-capability'
  | 'self-dependency'
  | 'too-long'

export type ManifestValidation =
  | { readonly ok: true; readonly value: PluginManifest }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] }

// ---------------------------------------------------------------------------
// semver：只实现契约需要的子集，避免为一个范围判断引入依赖
// ---------------------------------------------------------------------------

export interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string') return null
  const matched = SEMVER_PATTERN.exec(value)
  if (!matched) return null
  const [, major, minor, patch, prerelease] = matched
  if (major === undefined || minor === undefined || patch === undefined) return null
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? '',
  }
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // 同号版本：无预发布的正式版 > 有预发布的候选版（semver 11.3）。
  if (a.prerelease === '' && b.prerelease === '') return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  if (a.prerelease === b.prerelease) return 0
  const left = a.prerelease.split('.')
  const right = b.prerelease.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const first = left[index]
    const second = right[index]
    if (first === undefined) return -1
    if (second === undefined) return 1
    if (first === second) continue
    const firstNumeric = /^\d+$/.test(first)
    const secondNumeric = /^\d+$/.test(second)
    if (firstNumeric && secondNumeric) {
      // 数字段可能超过 JS 安全整数；按十进制位数和字典序比较，不转 Number。
      const firstDigits = first.replace(/^0+(?=\d)/, '')
      const secondDigits = second.replace(/^0+(?=\d)/, '')
      if (firstDigits.length !== secondDigits.length) return firstDigits.length < secondDigits.length ? -1 : 1
      if (firstDigits !== secondDigits) return firstDigits < secondDigits ? -1 : 1
    } else if (firstNumeric !== secondNumeric) {
      return firstNumeric ? -1 : 1
    } else {
      return first < second ? -1 : 1
    }
  }
  return 0
}

interface Comparator {
  readonly op: '=' | '>' | '>=' | '<' | '<='
  readonly version: Semver
}

function caretUpperBound(version: Semver): Semver {
  if (version.major !== 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: '' }
  if (version.minor !== 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: '' }
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: '' }
}

function tildeUpperBound(version: Semver): Semver {
  // `~1.2.0` 允许补丁位变动，但不跨次版本；`~0.x` / `~1` 的语义同 caret 的收紧规则。
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: '' }
}

/**
 * 通配段（`1.x` / `1.2.*`）。
 *
 * 返回展开后的比较符；不是通配形态时返回 `null`（交由调用方走普通路径）。
 * 通配位置决定上界：`1.x` 锁 major（`>=1.0.0 <2.0.0`），`1.2.x` 锁 minor（`>=1.2.0 <1.3.0`）。
 */
function parseWildcardToken(rawOp: string | undefined, rawVersion: string): Comparator[] | null {
  const segments = rawVersion.split('.')
  if (segments.length > 3) return null
  const wildcardIndex = segments.findIndex((segment) => segment === 'x' || segment === 'X' || segment === '*')
  // 裸 `*` / `x` / `X` 已在 parseAlternative 入口当作「任意版本」处理。
  if (wildcardIndex <= 0) return null
  if (segments.slice(wildcardIndex).some((segment) => segment !== 'x' && segment !== 'X' && segment !== '*')) {
    return null
  }
  const numeric = segments.slice(0, wildcardIndex)
  if (numeric.some((segment) => !/^\d+$/.test(segment))) return null

  const lower: Semver = {
    major: Number(numeric[0] ?? 0),
    minor: Number(numeric[1] ?? 0),
    patch: 0,
    prerelease: '',
  }
  const upper: Semver =
    wildcardIndex === 1
      ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: '' }
      : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: '' }

  switch (rawOp) {
    case undefined:
    case '=':
      return [
        { op: '>=', version: lower },
        { op: '<', version: upper },
      ]
    case '^':
      return [
        { op: '>=', version: lower },
        { op: '<', version: caretUpperBound(lower) },
      ]
    case '~':
      return [
        { op: '>=', version: lower },
        { op: '<', version: tildeUpperBound(lower) },
      ]
    // `>=1.x` 这类组合在 npm 语义里无效，不猜测意图。
    default:
      return null
  }
}

function parseAlternative(raw: string): Comparator[] | null {
  const text = raw.trim()
  if (text === '') return null
  if (text === '*' || text === 'x' || text === 'X') return []
  const comparators: Comparator[] = []
  for (const token of text.split(/\s+/)) {
    if (token === '') continue
    const matched = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
    if (!matched) return null
    const [, rawOp, rawVersion] = matched
    if (rawVersion === undefined) return null
    const wildcard = parseWildcardToken(rawOp, rawVersion)
    if (wildcard) {
      comparators.push(...wildcard)
      continue
    }
    // 允许 `^1.2` / `~1` 这类简写：缺省段补 0。
    const normalized = normalizeLooseVersion(rawVersion)
    const version = parseSemver(normalized)
    if (!version) return null
    const op = rawOp ?? '='
    if (op === '^') {
      comparators.push({ op: '>=', version })
      comparators.push({ op: '<', version: caretUpperBound(version) })
    } else if (op === '~') {
      comparators.push({ op: '>=', version })
      comparators.push({ op: '<', version: tildeUpperBound(version) })
    } else {
      comparators.push({ op: op as Comparator['op'], version })
    }
  }
  return comparators
}

function normalizeLooseVersion(raw: string): string {
  const cleaned = raw.trim()
  if (SEMVER_PATTERN.test(cleaned)) return cleaned
  const parts = cleaned.split('-')
  const head = parts[0] ?? ''
  const suffix = parts.length > 1 ? `-${parts.slice(1).join('-')}` : ''
  const segments = head.split('.')
  if (segments.length === 0 || segments.length > 3) return cleaned
  while (segments.length < 3) segments.push('0')
  if (segments.some((segment) => !/^\d+$/.test(segment))) return cleaned
  return `${segments.join('.')}${suffix}`
}

function satisfiesComparator(version: Semver, comparator: Comparator): boolean {
  const order = compareSemver(version, comparator.version)
  switch (comparator.op) {
    case '=':
      return order === 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
  }
}

/** 判断版本是否满足范围。范围支持 `||` 分支与空格分隔的合取，子集见 `parseAlternative`。 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version)
  if (!parsedVersion || typeof range !== 'string') return false
  // 任一分支非法即拒绝整个范围，空 OR 分支不得退化成任意版本。
  const alternatives = range.split('||').map(parseAlternative)
  return alternatives.every((comparators) => comparators !== null) &&
    alternatives.some((comparators) => comparators?.every((comparator) => satisfiesComparator(parsedVersion, comparator)))
}

export function isValidRange(range: unknown): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false
  return range.split('||').every((alternative) => parseAlternative(alternative) !== null)
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 插件 ID：小写反向域名形态（至少两段），拒绝空格、绝对路径与 `.`/`..` 段。 */
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
/** 与契约 `ID_PATTERN` 的长度上限保持一致（128）。 */
const ID_MAX_LENGTH = 128
const SERVICE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/
const NAME_MAX_LENGTH = 80
const ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs']
const FORBIDDEN_PATH_FRAGMENTS = ['\\', '\0', '%2e', '%2E']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRelativeSafePath(value: string): boolean {
  if (value === '' || value.startsWith('/')) return false
  for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
    if (value.includes(fragment)) return false
  }
  // Windows 盘符与 UNC。
  if (/^[a-zA-Z]:/.test(value)) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return false
  return ENTRY_EXTENSIONS.some((extension) => value.endsWith(extension))
}

class IssueCollector {
  readonly issues: ManifestIssue[] = []

  add(path: string, code: ManifestIssueCode, message: string): void {
    this.issues.push({ path, code, message })
  }

  get failed(): boolean {
    return this.issues.length > 0
  }
}

function readString(
  source: Record<string, unknown>,
  field: string,
  collector: IssueCollector,
): string | undefined {
  if (!(field in source)) {
    collector.add(field, 'missing-field', `缺少必填字段 ${field}`)
    return undefined
  }
  const value = source[field]
  if (typeof value !== 'string' || value.trim() === '') {
    collector.add(field, 'wrong-type', `${field} 必须是非空字符串`)
    return undefined
  }
  return value
}

/**
 * 校验任意输入是否构成合法 Manifest。
 *
 * 刻意**收集全部问题**而不是遇到第一个就返回：插件作者一次就能看到所有错误，
 * 而不是改一个跑一次。返回值是自有的判别联合（不是 `Result<T>`），因为在失败分支上
 * 需要携带结构化 issue 列表，而 `ErrorPayload.detail` 只允许标量。
 */
export function validatePluginManifest(input: unknown): ManifestValidation {
  const collector = new IssueCollector()
  if (!isPlainObject(input)) {
    collector.add('', 'not-an-object', 'Manifest 必须是对象')
    return { ok: false, issues: collector.issues }
  }
  const source = input

  // --- id ---
  const id = readString(source, 'id', collector)
  if (id !== undefined) {
    // 🔴 刻意**不用** `isWellFormedId`：契约那个辅助函数面向 `ws_xxx` / UUID 形态的主键，
    // 不允许 `.`；而插件 id 按设计文档是反向域名形态（`"id": "yfe.characters"`，见
    // `05-插件内核与SDK.md:27`）。两者用途不同，混用会把所有合法插件 id 判为非法。
    if (id.length > ID_MAX_LENGTH) {
      collector.add('id', 'too-long', `id 超过 ${ID_MAX_LENGTH} 字符`)
    } else if (/[\u0000-\u001f\u007f]/.test(id)) {
      collector.add('id', 'malformed-id', 'id 含控制字符')
    } else if (!PLUGIN_ID_PATTERN.test(id)) {
      collector.add('id', 'malformed-id', 'id 必须是小写反向域名形态（至少两段，如 yfe.builtin.outline）')
    }
  }

  // --- name ---
  const name = readString(source, 'name', collector)
  if (name !== undefined) {
    if (name.length > NAME_MAX_LENGTH) {
      collector.add('name', 'too-long', `name 超过 ${NAME_MAX_LENGTH} 字符`)
    } else if (/[\u0000-\u001f\u007f]/.test(name)) {
      collector.add('name', 'wrong-type', 'name 含控制字符')
    }
  }

  // --- version ---
  const version = readString(source, 'version', collector)
  if (version !== undefined && !parseSemver(version)) {
    collector.add('version', 'malformed-version', `version 不是合法 semver：${version}`)
  }

  // --- manifestVersion ---
  const manifestVersion = source['manifestVersion']
  if (!('manifestVersion' in source)) {
    collector.add('manifestVersion', 'missing-field', '缺少必填字段 manifestVersion')
  } else if (manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    collector.add(
      'manifestVersion',
      'manifest-version-unsupported',
      `manifestVersion 必须为 ${PLUGIN_MANIFEST_VERSION}，收到 ${String(manifestVersion)}`,
    )
  }

  // --- hostApiRange ---
  const hostApiRange = readString(source, 'hostApiRange', collector)
  if (hostApiRange !== undefined && !isValidRange(hostApiRange)) {
    collector.add('hostApiRange', 'malformed-range', `hostApiRange 不是合法 semver 范围：${hostApiRange}`)
  }

  // --- kind ---
  const kind = source['kind']
  if (!('kind' in source)) {
    collector.add('kind', 'missing-field', '缺少必填字段 kind')
  } else if (!isPluginKind(kind)) {
    collector.add('kind', 'unknown-kind', `kind 必须是 ${PLUGIN_KINDS.join(' / ')} 之一`)
  }

  // --- platforms ---
  const platforms = source['platforms']
  const platformsOut: PluginPlatform[] = []
  if (!Array.isArray(platforms) || platforms.length === 0) {
    collector.add('platforms', platforms === undefined ? 'missing-field' : 'empty-list', 'platforms 必须是非空数组')
  } else {
    const seen = new Set<string>()
    platforms.forEach((platform, index) => {
      if (!isPluginPlatform(platform)) {
        collector.add(`platforms[${index}]`, 'unknown-platform', `未知平台 ${String(platform)}`)
        return
      }
      if (seen.has(platform)) {
        collector.add(`platforms[${index}]`, 'duplicate-entry', `平台重复：${platform}`)
        return
      }
      seen.add(platform)
      platformsOut.push(platform)
    })
  }

  // --- entries ---
  const entriesOut: { service?: string; ui?: string } = {}
  const entries = source['entries']
  if (!isPlainObject(entries)) {
    collector.add('entries', entries === undefined ? 'missing-field' : 'wrong-type', 'entries 必须是对象')
  } else {
    let entryCount = 0
    for (const key of ['service', 'ui'] as const) {
      const value = entries[key]
      if (value === undefined) continue
      entryCount += 1
      if (typeof value !== 'string' || !isRelativeSafePath(value)) {
        collector.add(
          `entries.${key}`,
          'path-escape',
          `entries.${key} 必须是包内相对路径且以 ${ENTRY_EXTENSIONS.join(' / ')} 结尾，禁止绝对路径与 .. 逃逸`,
        )
        continue
      }
      entriesOut[key] = value
    }
    if (entryCount === 0) {
      collector.add('entries', 'empty-list', 'entries 至少要有 service 或 ui 之一')
    }
  }

  // --- dependencies ---
  const dependenciesOut: PluginDependency[] = []
  const dependencies = source['dependencies']
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies)) {
      collector.add('dependencies', 'wrong-type', 'dependencies 必须是数组')
    } else {
      const seen = new Set<string>()
      dependencies.forEach((rawDependency, index) => {
        if (!isPlainObject(rawDependency)) {
          collector.add(`dependencies[${index}]`, 'wrong-type', '依赖项必须是对象')
          return
        }
        const dependencyId = rawDependency['id']
        const range = rawDependency['range']
        if (typeof dependencyId !== 'string' || !PLUGIN_ID_PATTERN.test(dependencyId)) {
          collector.add(`dependencies[${index}].id`, 'malformed-id', '依赖 id 必须是合法插件 ID')
          return
        }
        if (typeof range !== 'string' || !isValidRange(range)) {
          collector.add(`dependencies[${index}].range`, 'malformed-range', '依赖 range 不是合法 semver 范围')
          return
        }
        if (id !== undefined && dependencyId === id) {
          collector.add(`dependencies[${index}].id`, 'self-dependency', '插件不能依赖自身')
          return
        }
        if (seen.has(dependencyId)) {
          collector.add(`dependencies[${index}].id`, 'duplicate-entry', `依赖重复：${dependencyId}`)
          return
        }
        seen.add(dependencyId)
        dependenciesOut.push({ id: dependencyId, range })
      })
    }
  }

  // --- requiredServices ---
  const requiredServicesOut: string[] = []
  const requiredServices = source['requiredServices']
  if (requiredServices !== undefined) {
    if (!Array.isArray(requiredServices)) {
      collector.add('requiredServices', 'wrong-type', 'requiredServices 必须是数组')
    } else {
      const seen = new Set<string>()
      requiredServices.forEach((service, index) => {
        if (typeof service !== 'string' || !SERVICE_NAME_PATTERN.test(service)) {
          collector.add(`requiredServices[${index}]`, 'wrong-type', '服务名必须是字母开头的标识符')
          return
        }
        if (seen.has(service)) {
          collector.add(`requiredServices[${index}]`, 'duplicate-entry', `服务重复：${service}`)
          return
        }
        seen.add(service)
        requiredServicesOut.push(service)
      })
    }
  }

  // --- permissions ---
  const permissionsOut: PluginCapability[] = []
  const permissions = source['permissions']
  if (permissions === undefined) {
    collector.add('permissions', 'missing-field', '缺少必填字段 permissions（无权限请显式写 []）')
  } else if (!Array.isArray(permissions)) {
    collector.add('permissions', 'wrong-type', 'permissions 必须是数组')
  } else {
    const seen = new Set<string>()
    permissions.forEach((capability, index) => {
      if (!isPluginCapability(capability)) {
        collector.add(`permissions[${index}]`, 'unknown-capability', `未知能力 ${String(capability)}`)
        return
      }
      if (seen.has(capability)) {
        collector.add(`permissions[${index}]`, 'duplicate-entry', `能力重复：${capability}`)
        return
      }
      seen.add(capability)
      permissionsOut.push(capability)
    })
  }

  // --- contributes（贡献点唯一性） ---
  const contributesOut: { panels?: string[]; commands?: string[] } = {}
  const contributes = source['contributes']
  if (contributes !== undefined) {
    if (!isPlainObject(contributes)) {
      collector.add('contributes', 'wrong-type', 'contributes 必须是对象')
    } else {
      for (const key of ['panels', 'commands'] as const) {
        const list = contributes[key]
        if (list === undefined) continue
        if (!Array.isArray(list)) {
          collector.add(`contributes.${key}`, 'wrong-type', `contributes.${key} 必须是数组`)
          continue
        }
        const collected: string[] = []
        const seen = new Set<string>()
        list.forEach((contributionId, index) => {
          if (typeof contributionId !== 'string' || !isWellFormedId(contributionId)) {
            collector.add(`contributes.${key}[${index}]`, 'malformed-id', '贡献点 id 必须是合法标识符')
            return
          }
          if (seen.has(contributionId)) {
            collector.add(`contributes.${key}[${index}]`, 'duplicate-entry', `贡献点重复：${contributionId}`)
            return
          }
          seen.add(contributionId)
          collected.push(contributionId)
        })
        contributesOut[key] = collected
      }
    }
  }

  // --- dataSchemaVersion ---
  const dataSchemaVersion = source['dataSchemaVersion']
  if (dataSchemaVersion === undefined) {
    collector.add('dataSchemaVersion', 'missing-field', '缺少必填字段 dataSchemaVersion')
  } else if (
    typeof dataSchemaVersion !== 'number' ||
    !Number.isInteger(dataSchemaVersion) ||
    dataSchemaVersion < 1
  ) {
    collector.add('dataSchemaVersion', 'out-of-range', 'dataSchemaVersion 必须是 ≥1 的整数')
  }

  // --- configSchema ---
  const configSchema = source['configSchema']
  let configSchemaOut: Readonly<Record<string, unknown>> | undefined
  if (configSchema !== undefined) {
    if (isPlainObject(configSchema)) {
      configSchemaOut = configSchema
    } else {
      collector.add('configSchema', 'wrong-type', 'configSchema 必须是对象')
    }
  }

  if (collector.failed) return { ok: false, issues: collector.issues }

  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    hostApiRange: hostApiRange as string,
    kind: kind as PluginKind,
    platforms: platformsOut,
    entries: entriesOut,
    dependencies: dependenciesOut,
    requiredServices: requiredServicesOut,
    permissions: permissionsOut,
    contributes: contributesOut,
    dataSchemaVersion: dataSchemaVersion as number,
    ...(configSchemaOut === undefined ? {} : { configSchema: configSchemaOut }),
  }
  return { ok: true, value: manifest }
}

/**
 * 把 issue 列表压成 `ErrorPayload.detail` 允许的标量形式。
 *
 * 🔴 `detail` 只能是 `string | number | boolean | null`，且禁止包含正文、密钥、
 * 绝对路径中的用户名，因此这里只放**计数 + 前几条 issue 的路径与码**，不放 message 全文。
 */
export function summarizeManifestIssues(
  issues: readonly ManifestIssue[],
): Readonly<Record<string, string | number | boolean | null>> {
  const first = issues[0]
  return {
    reason: 'manifest-invalid',
    issueCount: issues.length,
    issueCodes: issues.map((issue) => issue.code).join(','),
    ...(first === undefined ? {} : { firstPath: first.path === '' ? '<root>' : first.path, firstCode: first.code }),
  }
}
