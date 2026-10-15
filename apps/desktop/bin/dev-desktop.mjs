#!/usr/bin/env node
/**
 * 桌面应用启动器：把「本机沙箱例外」翻译成**真正的 Chromium 命令行参数**。
 *
 * ## 为什么需要这一层
 *
 * Windows 工作区的 Low Integrity ACL 会使 Electron 降权，崩溃并拒绝写用户目录。
 * 启动器先将运行时内容缓存到用户目录，再构建产物、清理 ELECTRON_RUN_AS_NODE。
 * 关闭沙箱不是已验证的修复，不自动启用。
 *
 * ## 用法
 *
 *   npm run dev -w @yfe/desktop                      正常启动（沙箱照旧）
 *   npm run gui-check -w @yfe/desktop               真窗口自检（沙箱照旧）
 *   $env:YFE_DISABLE_SANDBOX=1; npm run dev -w @yfe/desktop     本机验证：追加 --no-sandbox
 *   node bin/dev-desktop.mjs --gui-check --no-sandbox            显式传参亦可
 *
 * 启动器会把这件事明确记在 stderr 上：关掉沙箱会显著削弱 renderer 隔离，
 * 绝不允许它悄无声息地生效。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererDevUrl } from '../src/main/renderer-policy.mjs';
import { prepareElectronRuntime } from './electron-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');

const require = createRequire(import.meta.url);
/** @type {string} */
let electronBinary;
try {
  // electron 包的入口在纯 Node 下导出的就是可执行文件路径（不是模块）。
  electronBinary = require('electron');
} catch (thrown) {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event: 'desktop.launcher', message: '未安装 electron，无法启动桌面应用', reason: thrown instanceof Error ? thrown.message : String(thrown), hint: 'npm install --save-dev electron' })}\n`,
  );
  process.exit(1);
}
if (typeof electronBinary !== 'string' || electronBinary.length === 0) {
  electronBinary = join(APP_ROOT, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
}
try {
  electronBinary = prepareElectronRuntime(electronBinary);
} catch (thrown) {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'desktop.runtime', message: 'Electron 运行时准备失败', reason: thrown instanceof Error ? thrown.message : String(thrown) })}\n`);
  process.exit(1);
}

const passthrough = process.argv.slice(2);
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

// 全新 checkout 没有 dist；本地文件模式必须先构建，避免首次启动白屏。
if (rendererDevUrl(process.env.YFE_RENDERER_URL) === null && !passthrough.includes('--help') && !passthrough.includes('-h')) {
  const viteEntry = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const built = await new Promise((resolve) => {
    const builder = spawn(process.execPath, [viteEntry, 'build', '--config', join(APP_ROOT, 'vite.config.ts')], {
      cwd: APP_ROOT, stdio: 'inherit', windowsHide: true,
    });
    builder.once('error', () => resolve(1));
    builder.once('exit', (code) => resolve(code ?? 1));
  });
  if (built !== 0) process.exit(1);
}
const sandboxDisabled = process.env.YFE_DISABLE_SANDBOX === '1' || passthrough.includes('--no-sandbox');
const args = [APP_ROOT, ...passthrough];
if (sandboxDisabled && !passthrough.includes('--no-sandbox')) args.push('--no-sandbox');

process.stderr.write(
  `${JSON.stringify({
    level: sandboxDisabled ? 'warn' : 'info',
    event: 'desktop.launcher',
    message: sandboxDisabled
      ? '本次以 --no-sandbox 启动：Chromium 沙箱被关闭，仅限本机验证，勿用于生产/验收安全项'
      : '以默认沙箱启动桌面应用',
    electron: electronBinary,
    args: args.slice(1),
  })}\n`,
);

const child = spawn(electronBinary, args, {
  cwd: APP_ROOT,
  stdio: 'inherit',
  windowsHide: false,
  env: childEnv,
});

// 主进程 ready 之前崩溃/挂起时，GUI 检查也要有明确的结束边界。
const watchdog = passthrough.includes('--gui-check') ? setTimeout(() => {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'desktop.launcher', message: 'Electron GUI 检查在 60 秒内未完成' })}\n`);
  child.kill();
}, 60_000) : null;

child.on('error', (thrown) => {
  clearTimeout(watchdog);
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event: 'desktop.launcher', message: '启动 electron 失败', reason: thrown.message })}\n`,
  );
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(watchdog);
  if (signal !== null) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'desktop.launcher', message: 'electron 被信号终止', signal })}\n`);
    process.exit(1);
  }
  if (code !== 0) {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'desktop.launcher', message: 'Electron 异常退出', exitCode: code, hex: code === null ? null : '0x' + (code >>> 0).toString(16) })}\n`);
  }
  process.exit(code === 0 ? 0 : 1);
});
