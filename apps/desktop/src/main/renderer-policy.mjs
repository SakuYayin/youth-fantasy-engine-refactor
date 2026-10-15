import { pathToFileURL } from 'node:url';

export function rendererDevUrl(value, packaged = false) {
  if (packaged || typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function isRendererUrl(candidate, rendererPath, devUrl = null) {
  try {
    const url = new URL(candidate);
    if (devUrl !== null) return url.origin === new URL(devUrl).origin;
    url.hash = '';
    url.search = '';
    return url.href === pathToFileURL(rendererPath).href;
  } catch { return false; }
}

export function isExternalUrl(value) {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function isTrustedSender(event, window, rendererPath, devUrl = null) {
  return window !== null && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isRendererUrl(event.senderFrame?.url, rendererPath, devUrl);
}
