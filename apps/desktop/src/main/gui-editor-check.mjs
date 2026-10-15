/** 真窗口验收：Vue 按钮 → CodeMirror 原生输入 → 保存 → 重新加载。 */
export async function collectEditorChecks(window) {
  const evaluate = (script) => window.webContents.executeJavaScript(script, true);
  const setup = await evaluate(`(async () => {
    const wait = async (predicate) => {
      for (let i = 0; i < 160; i++) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('编辑界面等待超时');
    };
    const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
    await wait(() => document.querySelector('.cm-editor'));
    await wait(() => (button('新建作品') && !button('新建作品').disabled) ||
      (button('新建章节') && !button('新建章节').disabled));
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
      input.value = '中文窗口编辑验收';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      button('新建作品').click();
      await wait(() => button('新建章节') && !button('新建章节').disabled);
    }
    const oldId = document.querySelector('[role="treeitem"][aria-selected="true"]')?.dataset.nodeId;
    button('新建章节').click();
    await wait(() => document.querySelector('.cm-content[contenteditable="true"]') &&
      document.querySelector('[role="treeitem"][aria-selected="true"]')?.dataset.nodeId !== oldId);
    const documentId = document.querySelector('[role="treeitem"][aria-selected="true"]').dataset.nodeId;
    document.querySelector('.cm-content').focus();
    return { documentId, previousBody };
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
    { name: 'ui.editor.save', ok: saved?.ok === true && containsBody(saved.value), detail: '界面新建作品/章节，原生输入中文、emoji、换行，Ctrl+S 后读回一致' },
    { name: 'ui.editor.reload', ok: restored === true, detail: '重新加载界面后选中章节，正文保持一致' },
    ...(setup.previousBody === null ? [] : [{ name: 'ui.editor.previous-session', ok: setup.previousBody?.ok === true && containsBody(setup.previousBody.value), detail: '再次启动时读回上次写入的完整正文' }]),
  ];
}
