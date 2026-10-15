import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { isExternalUrl, isRendererUrl, isTrustedSender, rendererDevUrl } from '../src/main/renderer-policy.mjs'

describe('桌面来源策略', () => {
  it('只允许明确的本机开发地址，打包程序始终加载本地产物', () => {
    expect(rendererDevUrl('http://127.0.0.1:5200')).toBe('http://127.0.0.1:5200/')
    for (const url of ['invalid', 'https://remote.test', 'file:///other.html', 'http://localhost.evil:5200', 'http://u:p@localhost:5200']) {
      expect(rendererDevUrl(url)).toBeNull()
    }
    expect(rendererDevUrl('http://localhost:5200', true)).toBeNull()
  })
  it('按 URL 精确判断来源，拒绝本地其他文件和开发地址前缀伪装', () => {
    const path = new URL('../src/renderer/index.html', import.meta.url)
    const local = pathToFileURL('F:/yfe/index.html').href
    expect(isRendererUrl(local + '#chapter', 'F:/yfe/index.html')).toBe(true)
    expect(isRendererUrl(path.href, 'F:/yfe/index.html')).toBe(false)
    expect(isRendererUrl('http://localhost:5200.evil.test', '', 'http://localhost:5200')).toBe(false)
    expect(isExternalUrl('file:///C:/Windows/system32/cmd.exe')).toBe(false)
    expect(isExternalUrl('https://example.com')).toBe(true)
  })
  it('仅主窗口主框架可调用 IPC', () => {
    const frame = { url: 'http://localhost:5200/' }
    const contents = { mainFrame: frame }
    const window = { webContents: contents, isDestroyed: () => false }
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, window, '', 'http://localhost:5200')).toBe(true)
    expect(isTrustedSender({ sender: contents, senderFrame: { ...frame } }, window, '', 'http://localhost:5200')).toBe(false)
    expect(isTrustedSender({ sender: {}, senderFrame: frame }, window, '', 'http://localhost:5200')).toBe(false)
  })
})
