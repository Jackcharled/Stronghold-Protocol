// Static boot diagnostics: CSP allows external scripts, never inline event handlers.
// i18n-ignore-file: pre-module legacy-browser fallback, as public/index.html.
// Boot diagnostics (plain ES5: runs everywhere). A browser too old for the app says so instead of spinning forever:
    // no ES modules (nomodule below), a module graph that cannot load (e.g. import maps: Safari / iOS < 16.4), or no
    // boot after 9 s.
    window.__spBootFail = function (why) {
      var e = document.getElementById('boot-err');
      if (!e || e.getAttribute('data-final')) return;
      var im;
      try { im = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')); } catch (_x) { im = false; }
      // 自动重试：首屏模块并发加载偶发失败（网络抖动/HTTP2 流中断）时，
      // 先等连接恢复再刷新。最多 3 次，避免一次瞬时失败就永久停在错误页。
      try {
        var tries = Number(sessionStorage.getItem('sp_boot_retry') || 0) || 0;
        if (why !== 'old' && tries < 3) {
          sessionStorage.setItem('sp_boot_retry', String(tries + 1));
          var u = new URL(location.href);
          u.searchParams.set('retry', String(Date.now()));
          setTimeout(function () { location.replace(u.toString()); }, 500 * (tries + 1));
          return;
        }
      } catch (_r) { /* 忽略 */ }
      e.textContent = why === 'old' || !im
        ? '当前浏览器版本过旧，无法运行本游戏。请升级到 iOS / iPadOS 16.4+（Safari 16.4+）、Chrome / Edge 90+ 或 Firefox 108+ 后刷新。'
        : '游戏脚本加载失败，请检查网络连接后重试。';
      try {
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重新加载';
        retry.style.cssText = 'margin-top:12px;padding:8px 20px;border:1px solid #4ed8af;border-radius:4px;background:#0b1a16;color:#9fe8d2;font:14px/1.2 system-ui,sans-serif;cursor:pointer';
        retry.addEventListener('click', function () { location.reload(); });
        e.appendChild(document.createElement('br'));
        e.appendChild(retry);
      } catch (_b) { /* 忽略 */ }
      e.setAttribute('data-final', '1');
    };
    // a module graph that fails to link (bare specifier without import-map support) reports here, not on the <script>
    window.addEventListener('error', function (ev) {
      var b = document.getElementById('boot');
      if (!b || b.classList.contains('is-done')) return;
      if (/specifier|resolve|import|module/i.test(String(ev && ev.message))) window.__spBootFail('load');
    });
  
// If modules never boot (very old browser / blocked script), explain instead of spinning forever.
    setTimeout(function () {
      var b = document.getElementById('boot'), e = document.getElementById('boot-err');
      if (b && !b.classList.contains('is-done') && e && !e.textContent) e.textContent = '加载时间较长…如长时间无响应，请使用最新版 Chrome / Edge / Safari / Firefox 并刷新页面。';
    }, 9000);
  
document.addEventListener('error', function (event) {
  if (event.target && event.target.id === 'sp-main') window.__spBootFail('load');
}, true);
