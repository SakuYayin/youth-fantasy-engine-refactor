import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function runtimeDigest(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`Electron 目录不能是链接：${directory}`);
  const hash = createHash('sha256');
  function visit(current, relative = '') {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + '/' + entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, name);
      else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        hash.update(JSON.stringify([name, bytes.length]));
        hash.update(bytes);
      } else throw new Error(`Electron 运行时包含不支持的文件类型：${absolute}`);
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function copyContents(source, destination) {
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copyContents(join(source, entry.name), join(destination, entry.name));
    else if (entry.isFile()) writeFileSync(join(destination, entry.name), readFileSync(join(source, entry.name)), { flag: 'wx' });
    else throw new Error(`Electron 运行时包含不支持的文件类型：${entry.name}`);
  }
}

/**
 * Windows 开发目录可能继承 Low Integrity/能力 SID 的沙箱 ACL。
 * 新建文件只复制内容，避免 Electron 主进程被降到 Low、渲染进程启动失败。
 * 缓存在用户目录；不改仓库/系统 ACL，也不关闭 Chromium 沙箱。
 */
export function prepareElectronRuntime(binary, {
  platform = process.platform,
  cacheRoot = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'YouthFantasyEngine', 'electron-runtime'),
} = {}) {
  if (platform !== 'win32') return binary;
  const source = dirname(binary);
  const digest = runtimeDigest(source);
  mkdirSync(cacheRoot, { recursive: true });
  const destination = join(cacheRoot, digest);
  if (existsSync(destination)) {
    if (runtimeDigest(destination) !== digest) throw new Error(`Electron 缓存校验失败：${destination}`);
    return join(destination, 'electron.exe');
  }
  // 先完整复制和校验再发布；并发启动只会复用完整目录。
  const staging = join(cacheRoot, `.staging-${randomUUID()}`);
  copyContents(source, staging);
  if (runtimeDigest(staging) !== digest) throw new Error('Electron 运行时复制校验失败');
  try { renameSync(staging, destination); }
  catch (error) {
    if (!existsSync(destination) || runtimeDigest(destination) !== digest) throw error;
  }
  return join(destination, 'electron.exe');
}
