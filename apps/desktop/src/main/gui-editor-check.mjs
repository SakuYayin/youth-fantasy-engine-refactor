/**
 * 真窗口验收：Vue 按钮 → CodeMirror 原生输入 → 保存 → 重新加载。
 *
 * 🔴 为什么必须先走「首启关」：加了 W8 外壳之后，**全新 profile 的第一次启动会先停在欢迎向导**，
 * 那时写作页容器 `app__body` 是 `display:none`（外壳刻意用 `v-show` 保活编辑器实例，见 App.vue:470-474）。
 * 于是：
 *   1. `document.querySelector('.cm-content').focus()` 对**不可见**元素静默失败（不抛错）；
 *   2. `webContents.insertText()` 敲到空处，编辑器根本没收到 change；
 *   3. Ctrl+S 触发的 `flush()` 自然无稿可存 → 死等到超时 `界面正文未保存`。
 * 2026-10-16 实测就是这样挂的。所以下面先点掉向导再验编辑器。
 *
 * `options.expectWelcome` 为真时额外断言首启确实显示了向导（只有全新 profile 才要求，
 * 复用 `--db-path` 的 profile 已经写过标记，不能要求）。
 */

/**
 * @param {any} window Electron BrowserWindow
 * @param {{ expectWelcome?: boolean }} [options]
 */
export async function collectEditorChecks(window, options = {}) {
  const evaluate = (script) => window.webContents.executeJavaScript(script, true);
  const setup = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wait = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if (predicate()) return true; } catch (error) { void error; }
        await sleep(50);
      }
      try { if (predicate() === true) return true; } catch (error) { void error; }
      throw new Error(label);
    };
    const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
    const visible = (el) => el !== null && el !== undefined && el.offsetParent !== null;

    await wait(() => {
      const root = document.querySelector('#app');
      return root !== null && root.children.length > 0;
    }, 12000, '应用未挂载');

    // ① 首启关：欢迎向导在时先走掉它，否则下面 focus() 会打在不可见元素上。
    let wizardShown = false;
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('[data-testid="welcome-wizard"]') !== null) { wizardShown = true; break; }
      await sleep(50);
    }
    if (wizardShown) {
      const skip = document.querySelector('[data-testid="welcome-skip"]');
      if (skip === null || typeof skip.click !== 'function') {
        throw new Error('欢迎向导缺少「跳过」按钮（data-testid="welcome-skip"）');
      }
      skip.click();
      await wait(() => document.querySelector('[data-testid="welcome-wizard"]') === null, 8000, '欢迎向导未关闭');
    }
    // ② 「不再显示」勾选框可能没勾 ⇒ 显式写标记，后面的 reload 不会被向导二次拦住
    //    （重复加载后向导一显示，innerText 对 hidden 容器返回空串，reload 断言会假失败）。
    try { localStorage.setItem('yfe.welcomeSeen', '1'); } catch (error) { void error; }
    await wait(() => visible(document.querySelector('.cm-editor')), 8000, '编辑界面等待超时');

    const previous = localStorage.getItem('yfe.guiCheckDocumentId');
    let previousBody = null;
    if (previous) {
      previousBody = await window.yfe.call('getDocument', {
        context: { requestId: crypto.randomUUID(), workspaceId: 'ws_local' },
        documentId: previous,
      });
    }
    if (button('新建作品')) {
      const input = document.querySelector('input[placeholder="作品名"]');
      if (input === null) throw new Error('写作页空态缺少作品名输入框');
      input.value = '中文窗口编辑验收';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      button('新建作品').click();
      await wait(() => button('新建章节') && !button('新建章节').disabled, 8000, '新建作品后未出现章节工具条');
    }
    const oldId = document.querySelector('[role="treeitem"][aria-selected="true"]')?.dataset.nodeId;
    const addChapter = button('新建章节');
    if (addChapter === undefined) throw new Error('写作页缺少「新建章节」按钮');
    addChapter.click();
    await wait(() => document.querySelector('.cm-content[contenteditable="true"]') &&
      document.querySelector('[role="treeitem"][aria-selected="true"]')?.dataset.nodeId !== oldId,
      8000, '新建章节后编辑器未就绪');
    const documentId = document.querySelector('[role="treeitem"][aria-selected="true"]').dataset.nodeId;
    document.querySelector('.cm-content').focus();
    return { documentId, previousBody, wizardShown };
  })()`);
  const body = '窗口实际编辑：中文与 emoji🙂\n保存后重新打开仍在。';
  await window.webContents.insertText(body);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['control'] });
  const saved = await evaluate(`(async () => {
    for (let i = 0; i < 160; i++) {
      if (document.querySelector('[data-status="saved"]')) {
        const result = await window.yfe.call('getDocument', {
          context: { requestId: crypto.randomUUID(), workspaceId: 'ws_local' }, documentId: ${JSON.stringify(setup.documentId)},
        });
        if (JSON.stringify(result).includes(${JSON.stringify(body.slice(0, 15))})) {
          localStorage.setItem('yfe.guiCheckDocumentId', ${JSON.stringify(setup.documentId)});
          return result;
        }
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('界面正文未保存');
  })()`);
  const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  const restored = await evaluate(`(async () => {
    for (let i = 0; i < 160; i++) {
      const row = document.querySelector('[data-label-id="' + ${JSON.stringify(setup.documentId)} + '"]');
      if (row) row.click();
      const editor = document.querySelector('.cm-content');
      if (editor && editor.innerText.replace(/\\r/g, '') === ${JSON.stringify(body)}) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  })()`);
  const containsBody = (value) => {
    if (value === body) return true;
    return value !== null && typeof value === 'object' && Object.values(value).some(containsBody);
  };
  return [
    // 只有全新 profile 才要求看到向导：复用 `--db-path` 的 profile 已经写过「已看过」标记。
    ...(options.expectWelcome === true
      ? [{
          name: 'ui.welcome.first-run',
          ok: setup.wizardShown === true,
          detail: '全新 profile 首启必须先显示欢迎向导，点「跳过」后进入写作页空态',
        }]
      : []),
    { name: 'ui.editor.save', ok: saved?.ok === true && containsBody(saved.value), detail: '界面新建作品/章节，原生输入中文、emoji、换行，Ctrl+S 后读回一致' },
    { name: 'ui.editor.reload', ok: restored === true, detail: '重新加载界面后选中章节，正文保持一致' },
    ...(setup.previousBody === null ? [] : [{ name: 'ui.editor.previous-session', ok: setup.previousBody?.ok === true && containsBody(setup.previousBody.value), detail: '再次启动时读回上次写入的完整正文' }]),
  ];
}