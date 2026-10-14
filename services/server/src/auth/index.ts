/**
 * `@yfe/server/auth` 公开面。
 *
 * 只导出**身份与访问控制**相关的原语；HTTP 装配在 `../http/server.js`。
 *
 * 🔴 导出的每个函数都遵守同一条纪律：
 * **授权主体必须由服务端会话/设备凭据产生**（`principalFromSession` / `principalFromDevice`），
 * 绝不接受调用方传入的 `userId` / `role`。
 * 因此这里没有 `principalFromBody` 之类的入口——不是遗漏，是刻意的。
 */

// --- 密码摘要 ---
export {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_ALGORITHM,
  burnPasswordCheck,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  rehashPassword,
  verifyPassword,
} from './password.js'
export type { ParsedPasswordHash, ScryptParams } from './password.js'

// --- 秘密生成与摘要 ---
export {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  TOKEN_BYTES,
  deriveCsrfToken,
  formatPairingCode,
  generateCsrfSecret,
  generatePairingCode,
  generateToken,
  hashPairingCode,
  hashToken,
  normalizePairingCode,
  sha256Hex,
  timingSafeEqualString,
  verifyCsrfToken,
  verifyToken,
} from './secrets.js'

// --- 会话与刷新轮换 ---
export {
  DEFAULT_SESSION_POLICY,
  REFRESH_COOKIE_PATH,
  addMilliseconds,
  assertSessionPolicyConsistent,
  buildSessionCookies,
  clearSessionCookies,
  cookieNames,
  csrfTokenOf,
  isExpired,
  issueSession,
  logoutSession,
  lookupFailureToError,
  lookupSessionByAccessToken,
  rotateRefreshToken,
  verifyCsrf,
} from './session.js'
export type {
  CookieSpec,
  IssuedSession,
  IssueSessionInput,
  RotateFailure,
  RotateInput,
  RotateResult,
  SessionLookupFailure,
  SessionLookupResult,
  SessionPolicy,
} from './session.js'

// --- 设备配对 ---
export {
  DEFAULT_PAIRING_POLICY,
  authenticateDevice,
  buildPairingCodeHash,
  cancelPairingCode,
  createPairingCode,
  deviceAuthFailureToError,
  listOwnDevices,
  pairingCodeState,
  redeemPairingCode,
  renameOwnDevice,
  revokeAllDeviceAccess,
  revokeOwnDevice,
} from './pairing.js'
export type {
  CreatedPairingCode,
  CreatePairingCodeInput,
  DeviceAuthFailure,
  DeviceAuthResult,
  PairingFailureReason,
  PairingPolicy,
  RedeemPairingCodeInput,
  RedeemPairingCodeResult,
} from './pairing.js'

// --- 权限 ---
export {
  assertCanManageDevice,
  assertCanManageMembers,
  assertCanRunRemoteCommand,
  assertCanWrite,
  assertDeviceWithinWorkspace,
  assertNotLastAdmin,
  assertNotLastOwner,
  principalFromDevice,
  principalFromSession,
  resolveWorkspaceAccess,
} from './permission.js'
export type { DeniedAttempt, Principal, WorkspaceAccess } from './permission.js'
