/**
 * 占位页的探测脚本（外部文件，因为 CSP 禁止内联脚本）。
 *
 * 它只做一件事：证明 renderer 拿到的桥**只有白名单方法**，且链路能通到数据库。
 * 真实界面代码进来后本文件即可删除。
 */
(function () {
  'use strict';
  var out = document.getElementById('out');

  function line(text, cls) {
    var span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\n';
    out.appendChild(span);
  }

  if (!window.yfe || typeof window.yfe.call !== 'function') {
    out.textContent = '';
    line('✗ 未检测到 window.yfe —— preload 未加载或 contextIsolation 配置异常。', 'bad');
    return;
  }

  out.textContent = '';
  line('✓ preload 桥已就绪（protocolVersion=' + String(window.yfe.protocolVersion) + '）', 'ok');
  line('白名单方法：' + window.yfe.methods.join(', '), 'dim');
  line('', null);

  // ① 白名单外的方法必须在 preload 层就被拒（不应到达 main）
  window.yfe.call('fs.readFile', { path: 'C:/Windows/System32/config/SAM' }).then(function (res) {
    var code = res && res.error && res.error.code;
    if (res && res.ok === false && code === 'PERMISSION_METHOD_NOT_ALLOWED') {
      line('✓ 白名单外调用被拒：' + code, 'ok');
    } else {
      line('✗ 白名单外调用竟然通过：' + JSON.stringify(res), 'bad');
    }
  });

  // ② 白名单内方法应真实到达 db-worker 与 SQLite
  window.yfe
    .call('systemStatus', null)
    .then(function (res) {
      line('', null);
      if (res && res.ok === true) {
        line('✓ systemStatus 返回：', 'ok');
        line(JSON.stringify(res.value, null, 2), null);
      } else {
        line('✗ systemStatus 失败：' + JSON.stringify(res && res.error), 'bad');
      }
    })
    .catch(function (error) {
      line('✗ IPC 抛出：' + String(error && error.message ? error.message : error), 'bad');
    });
})();
