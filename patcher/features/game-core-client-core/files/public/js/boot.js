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
      //
      // 注意 tries 只在「一次真正成功的启动」时才清零（下方 boot-done 事件）。
      // 以前它只增不减：玩家网络抖一次就用掉了重试次数，之后再刷新永远停在
      // 错误页（错误页上的「重新加载」也没用，因为它不会清计数器），
      // 只能关掉整个标签页重开 —— 玩家反馈的「一直刷新都不能好」就是这个。
      try {
        var tries = Number(sessionStorage.getItem('sp_boot_retry') || 0) || 0;
        // 手动点「重新加载」时带 ?boot=1：这时无条件清掉计数并从头再来一次。
        var manual = /[?&]boot=1(?:&|$)/.test(location.search);
        if (manual) { tries = 0; try { sessionStorage.removeItem('sp_boot_retry'); } catch (_m) { /* 忽略 */ } }
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
        : '游戏脚本加载失败，请检查网络连接后重试。（如果反复刷新都停在这里，请按 Ctrl+F5 强制刷新，或用浏览器菜单清除本站缓存）';
      try {
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重新加载';
        retry.style.cssText = 'margin-top:12px;padding:8px 20px;border:1px solid #4ed8af;border-radius:4px;background:#0b1a16;color:#9fe8d2;font:14px/1.2 system-ui,sans-serif;cursor:pointer';
        // 带 boot=1：清掉重试计数并绕过缓存重新加载（只 location.reload() 的话，
        // 计数仍然是 3，下次照样停在错误页 —— 玩家会以为「刷新没用」）。
        retry.addEventListener('click', function () {
          try { sessionStorage.removeItem('sp_boot_retry'); } catch (_c) { /* 忽略 */ }
          var u2 = new URL(location.href);
          u2.searchParams.set('boot', '1');
          u2.searchParams.set('retry', String(Date.now()));
          location.replace(u2.toString());
        });
        e.appendChild(document.createElement('br'));
        e.appendChild(retry);
      } catch (_b) { /* 忽略 */ }
      e.setAttribute('data-final', '1');
    };
    // 启动成功时把重试计数清零：一次成功就等于「网络已经好了」，
    // 不该为之前的抖动继续背着次数。
    function clearBootRetry() { try { sessionStorage.removeItem('sp_boot_retry'); } catch (_x) { /* 忽略 */ } }
    if (window.__SP__) clearBootRetry();
    document.addEventListener('sp-boot-ok', clearBootRetry);
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
