// 标题页：邮箱登录 / 注册（图形验证码） / 游客访问
(function () {
  if (window.__mmAccountTitle) return;
  window.__mmAccountTitle = true;

  const state = { user: null, guest: false, busy: false, mode: 'login', cooldown: 0, timer: null, captchaId: '', authReady: false };

  const api = async (path, opts) => {
    const o = { credentials: 'same-origin', cache: 'no-store', ...(opts || {}) };
    try {
      const sid = localStorage.getItem('mm.sid');
      if (sid) o.headers = { ...(o.headers || {}), authorization: 'Bearer ' + sid };
    } catch { /* 隐私模式 */ }
    const r = await fetch('/mm' + path, o);
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j };
  };

  function titleScreen() {
    const el = document.querySelector('.title-screen');
    return el && el.offsetParent ? el : null;
  }
  function findCallsign() {
    const scr = titleScreen();
    if (!scr) return null;
    return scr.querySelector('input.field__input')
      || [...scr.querySelectorAll('input')].find((i) => /代号|CALLSIGN/i.test(i.placeholder || ''))
      || null;
  }

  const inputStyle = 'background:#0a1114;border:1px solid #27393b;color:#dfe;border-radius:6px;padding:6px 10px;font-size:12px;width:100%;box-sizing:border-box';
  const btnStyle = 'flex:1;background:#1b2a2e;border:1px solid #2f4a4f;color:#7ff0cf;border-radius:6px;padding:6px 0;font-size:12px';

  async function loadCaptcha() {
    try {
      const r = await api('/api/auth/captcha');
      if (!r.body || !r.body.ok) return;
      state.captchaId = r.body.id;
      const box = document.getElementById('mm-captcha-box');
      if (box) {
        box.innerHTML = r.body.svg;
        const svg = box.querySelector('svg');
        if (svg) { svg.style.width = '120px'; svg.style.height = '44px'; svg.style.borderRadius = '6px'; svg.style.cursor = 'pointer'; svg.title = '点击刷新'; }
        box.onclick = loadCaptcha;
      }
      const inp = document.getElementById('mm-acc-captcha');
      if (inp) {
        inp.value = '';
        inp.style.cssText = (inp.style.cssText || '') + ';height:44px;font-size:16px;min-width:110px;flex:1 1 120px;padding:8px 10px';
        if (!inp.__mmFocusBound) {
          inp.__mmFocusBound = true;
          inp.addEventListener('focus', () => {
            setTimeout(() => { try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* 忽略 */ } }, 280);
          });
        }
      }
    } catch { /* 忽略 */ }
  }

  function fieldBoxOf(input) {
    return (input && input.closest('.field__box')) || (input ? input.parentElement : null);
  }
  // 登录面板要挂在游戏代号 field 之后（兄弟节点），否则会被隐藏规则一起藏掉
  function anchorOf(input) {
    if (!input) return null;
    return input.closest('.field') || input.closest('label') || fieldBoxOf(input);
  }
  // 「博士代号 CALLSIGN」标题在登录/注册态也应隐藏
  function fieldLabelOf(input) {
    if (!input) return null;
    const field = input.closest('.field') || input.closest('label');
    if (field) {
      const l = field.querySelector('.field__label');
      if (l) return l;
    }
    const box = fieldBoxOf(input);
    let prev = box ? box.previousElementSibling : null;
    if (prev && /代号|CALLSIGN/i.test(prev.textContent || '')) return prev;
    return null;
  }
  function setLabelVisible(label, on) {
    if (!label) return;
    label.style.display = on ? '' : 'none';
  }
  function startButton() {
    return [...document.querySelectorAll('button')].find((b) => /开始/.test((b.textContent || '').trim()));
  }
  function setStartEnabled(on) {
    const btn = startButton();
    if (!btn) return;
    // 未登录/未选游客时整个隐藏开始按钮，避免界面被拉长
    btn.style.display = on ? '' : 'none';
    btn.disabled = !on;
  }

  // 标题下方的一行同步提示（未登录=邀请登录；已登录=已同步状态）
  function ensureSyncHint() {
    const tagline = document.querySelector('.title-main .title-tag') || document.querySelector('.title-tag');
    if (!tagline) return;
    if (document.getElementById('mm-sync-hint')) return;
    const hint = document.createElement('p');
    hint.id = 'mm-sync-hint';
    hint.style.cssText = 'margin:8px 0 2px;text-align:center;font-size:15px;font-weight:600;letter-spacing:1px;color:#f0c674';
    tagline.insertAdjacentElement('afterend', hint);
  }

  function renderSyncHint() {
    const hint = document.getElementById('mm-sync-hint');
    if (!hint) return;
    if (state.user) {
      hint.textContent = '已同步：干员调配 · 皮肤 · 对局统计';
      hint.style.color = '#7ff0cf';
    } else {
      hint.textContent = '登录以同步干员调配、皮肤与对局统计';
      hint.style.color = '#f0c674';
    }
  }

  function build(afterEl) {
    const wrap = document.createElement('div');
    wrap.id = 'mm-acc-wrap';
    wrap.style.cssText = 'margin-top:2px;margin-bottom:0;display:flex;flex-direction:column;gap:3px;overflow:visible';

    const form = document.createElement('div');
    form.id = 'mm-acc-form';
    form.style.cssText = 'display:flex;flex-direction:column;gap:5px';

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;width:100%;border:1px solid #2f4a4f;border-radius:2px;overflow:hidden;margin-bottom:2px';
    tabs.innerHTML = '<button type="button" id="mm-tab-login" style="flex:1;border:0;cursor:pointer;padding:7px 0;font-size:13px;letter-spacing:3px;background:#9ff0d8;color:#07100f;font-weight:600">登录</button>'
      + '<button type="button" id="mm-tab-reg" style="flex:1;border:0;border-left:1px solid #2f4a4f;cursor:pointer;padding:7px 0;font-size:13px;letter-spacing:3px;background:#0b1416;color:#c9dbe0">注册</button>';

    const fields = document.createElement('div');
    fields.id = 'mm-acc-fields';
    fields.style.cssText = 'display:flex;flex-direction:column;gap:8px';

    const msg = document.createElement('div');
    msg.id = 'mm-acc-msg';
    msg.style.cssText = 'font-size:12px;color:#ffb4a8;min-height:14px';

    form.appendChild(tabs);
    form.appendChild(fields);
    form.appendChild(msg);

    const guestRow = document.createElement('div');
    guestRow.id = 'mm-acc-guest-row';
    guestRow.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;font-size:14px;color:#9fb4b8;line-height:1.35;text-align:center;padding:2px 0';
    guestRow.innerHTML = '<a href="#" id="mm-acc-guest" style="color:#7ff0cf;text-decoration:none;font-size:14px;white-space:nowrap">游客访问 ›</a>'
      + '<span style="font-size:14px">不登录也能游玩，但不能创建同盟/添加 AI</span>';

    const logged = document.createElement('div');
    logged.id = 'mm-acc-logged';
    logged.style.cssText = 'display:none;align-items:center;justify-content:center;gap:10px;font-size:12px;color:#9fb4b8;margin-top:2px';
    logged.innerHTML = '<span id="mm-acc-who"></span>'
      + '<a href="#" id="mm-acc-rename" style="display:inline-block;padding:3px 12px;border:1px solid #2f4a4f;border-radius:999px;background:rgba(19,28,31,.9);color:#c9dbe0;text-decoration:none;font-size:11px;line-height:16px">修改博士代号</a>'
      + '<a href="#" id="mm-acc-passwd" style="display:inline-block;padding:3px 12px;border:1px solid #2f4a4f;border-radius:999px;background:rgba(19,28,31,.9);color:#c9dbe0;text-decoration:none;font-size:11px;line-height:16px">修改密码</a>'
      + '<a href="#" id="mm-acc-reset" style="display:inline-block;padding:3px 12px;border:1px solid #4a3a2f;border-radius:999px;background:rgba(31,24,19,.9);color:#f0c674;text-decoration:none;font-size:11px;line-height:16px">重置云端数据</a>'
      + '<a href="/mm/admin.html" target="_blank" id="mm-acc-admin" style="display:none;padding:3px 14px;border:1px solid #2f4a4f;border-radius:999px;'
      + 'background:rgba(19,28,31,.9);color:#f0c674;text-decoration:none;font-size:11px;line-height:16px;letter-spacing:.5px">管理后台</a>'
      + '<a href="#" id="mm-acc-out" style="display:inline-block;padding:3px 14px;border:1px solid #2f4a4f;border-radius:999px;'
      + 'background:rgba(19,28,31,.9);color:#7ff0cf;text-decoration:none;font-size:11px;line-height:16px;letter-spacing:.5px">登出</a>';

    const hint = document.createElement('div');
    hint.id = 'mm-acc-guest-hint';
    hint.style.cssText = 'display:none;align-items:center;gap:10px;font-size:12px;color:#9fb4b8';
    hint.innerHTML = '<span>游客模式（不能创建同盟/添加 AI）</span><a href="#" id="mm-acc-back" style="color:#7ff0cf;text-decoration:none">返回登录</a>';

    wrap.appendChild(form);
    wrap.appendChild(guestRow);
    wrap.appendChild(logged);
    wrap.appendChild(hint);
    afterEl.insertAdjacentElement('afterend', wrap);

    tabs.querySelector('#mm-tab-login').onclick = (e) => { e.preventDefault(); state.mode = 'login'; renderFields(); };
    tabs.querySelector('#mm-tab-reg').onclick = (e) => { e.preventDefault(); state.mode = 'register'; renderFields(); };
    guestRow.querySelector('#mm-acc-guest').onclick = (e) => {
      e.preventDefault();
      state.guest = true;
      // 进入游客模式时清掉账号残留的代号（避免把账号名带进游客身份）
      const cs = findCallsign();
      if (cs && /#\d{4}\s*$/.test(cs.value || '')) {
        cs.value = '';
        try { cs.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 忽略 */ }
      }
      render();
    };
    hint.querySelector('#mm-acc-back').onclick = (e) => { e.preventDefault(); state.guest = false; render(); };
    logged.querySelector('#mm-acc-rename').onclick = async (e) => {
      e.preventDefault();
      const cur = state.user ? (state.user.nickname || '') : '';
      const v = prompt('输入新的博士代号（1~7 字）', cur);
      if (!v) return;
      const r = await api('/api/auth/set-name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: v.trim() }) });
      if (!r.body || !r.body.ok) { alert('修改失败：代号需 1~7 个字'); return; }
      state.user = { ...state.user, ...r.body.user };
      window.__SP_ACCOUNT_TOKEN = r.body.userToken || window.__SP_ACCOUNT_TOKEN || null;
      window.__SP_ADMIN_TOKEN = r.body.adminToken || window.__SP_ADMIN_TOKEN || null;
      window.__SP_ACCOUNT_TAG = state.user && state.user.tag ? String(state.user.tag) : null;
      if (state.user && state.user.tag) {
        try { localStorage.setItem('mm.tag', String(state.user.tag)); } catch { /* ignore */ }
        try { window.dispatchEvent(new Event('sp-account-token')); } catch { /* ignore */ }
      }
      if (r.body.user && r.body.user.tag && r.body.user.nickname) {
        try { localStorage.setItem('mm.name', r.body.user.nickname); } catch { /* 忽略 */ }
      }
      alert('代号已修改；重新进入对局后其他玩家会看到新代号。');
      render();
    };
    logged.querySelector('#mm-acc-passwd').onclick = async (e) => {
      e.preventDefault();
      const oldPw = prompt('请输入当前密码');
      if (!oldPw) return;
      const pw1 = prompt('请输入新密码（至少 8 位）');
      if (!pw1) return;
      if (pw1.length < 8) { alert('新密码至少 8 位'); return; }
      const pw2 = prompt('请再次输入新密码以确认');
      if (!pw2) return;
      if (pw1 !== pw2) { alert('两次输入的新密码不一致，请重新操作'); return; }
      const r = await api('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oldPassword: oldPw, newPassword: pw1 }) });
      if (!r.body || !r.body.ok) {
        const map = { bad_old_password: '当前密码不正确', invalid_password: '新密码至少 8 位' };
        alert('修改失败：' + (map[(r.body && r.body.error) || ''] || '请稍后重试'));
        return;
      }
      alert('密码已修改成功，其他设备上的登录已失效。');
    };
    logged.querySelector('#mm-acc-reset').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('确定重置云端数据？\n\n将清空：干员调配、持有、自选编队、皮肤、外观插件、提示/公告已读、对局统计。\n账号本身与昵称不受影响。')) return;
      const r = await api('/api/prefs/reset', { method: 'POST' });
      if (!r.body || !r.body.ok) { alert('重置失败，请稍后重试'); return; }
      try {
        for (const key of Object.values(PREF_MAP)) localStorage.removeItem(key);
        localStorage.removeItem('mm.annDismissed');
      } catch { /* 忽略 */ }
      setSyncState('idle');
      alert('云端数据已重置，页面将刷新。');
      location.reload();
    };
    logged.querySelector('#mm-acc-out').onclick = async (e) => {
      e.preventDefault();
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null; state.guest = false; syncReady = false;
    window.__SP_ADMIN_TOKEN = null;
    window.__SP_ACCOUNT_TOKEN = null;
      clearAccountCache();
      // 清掉输入框里的账号代号，避免游客模式继承
      const cs = findCallsign();
      if (cs) {
        cs.value = '';
        cs.readOnly = false;
        try { cs.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 忽略 */ }
      }
      render();
    };

    renderFields();
  }

  function renderFields() {
    const fields = document.getElementById('mm-acc-fields');
    if (!fields) return;
    const tabLogin = document.getElementById('mm-tab-login');
    const tabReg = document.getElementById('mm-tab-reg');
    if (tabLogin && tabReg) {
      const onLogin = state.mode === 'login';
      Object.assign(tabLogin.style, {
        background: onLogin ? '#9ff0d8' : '#0b1416',
        color: onLogin ? '#07100f' : '#c9dbe0',
        fontWeight: onLogin ? '600' : '400',
      });
      Object.assign(tabReg.style, {
        background: onLogin ? '#0b1416' : '#9ff0d8',
        color: onLogin ? '#c9dbe0' : '#07100f',
        fontWeight: onLogin ? '400' : '600',
      });
    }
    const captchaRow = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
      + '<div id="mm-captcha-box" style="width:120px;height:44px;flex:none;border-radius:6px;overflow:hidden;background:#0b1416"></div>'
      + '<input id="mm-acc-captcha" placeholder="图形验证码" autocomplete="off" inputmode="text" style="flex:1 1 120px;min-width:110px;height:44px;font-size:16px" />'
      + '<a href="#" id="mm-captcha-refresh" style="color:#7ff0cf;text-decoration:none;font-size:13px;flex:none;padding:6px 2px">换一张</a>'
      + '</div>';

    if (state.mode === 'login') {
      fields.innerHTML = '<input id="mm-acc-email" placeholder="QQ 邮箱" autocomplete="username" />'
        + '<input id="mm-acc-pass" type="password" placeholder="密码" autocomplete="current-password" />'
        + captchaRow
        + '<div style="display:flex;gap:8px;align-items:center"><button id="mm-acc-login" style="' + btnStyle + '">登录</button>'
        + '<a href="#" id="mm-acc-forgot" style="color:#9fb4b8;text-decoration:none;font-size:11px;flex:none">忘记密码</a></div>';
      fields.querySelectorAll('input').forEach((i) => (i.style.cssText = inputStyle));
      fields.querySelector('#mm-acc-login').onclick = () => submitLogin();
      fields.querySelector('#mm-acc-forgot').onclick = (e) => { e.preventDefault(); startReset(); };
      fields.querySelector('#mm-acc-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
    } else {
      fields.innerHTML = '<input id="mm-acc-email" placeholder="QQ 邮箱（如 123456@qq.com）" autocomplete="username" />'
        + '<div style="display:flex;gap:8px"><input id="mm-acc-code" placeholder="6 位邮箱验证码" style="flex:1" />'
        + '<button id="mm-acc-send" style="width:120px;background:#131c1f;border:1px solid #27393b;color:#9fb4b8;border-radius:6px;padding:8px 0;font-size:12px">发送验证码</button></div>'
        + '<input id="mm-acc-pass" type="password" placeholder="密码（至少 8 位）" autocomplete="new-password" />'
        + captchaRow
        + '<div style="display:flex;gap:8px"><button id="mm-acc-reg" style="' + btnStyle + '">注册并登录</button></div>';
      fields.querySelectorAll('input').forEach((i) => (i.style.cssText = inputStyle));
      fields.querySelector('#mm-acc-send').onclick = sendCode;
      fields.querySelector('#mm-acc-reg').onclick = () => submitRegister();
    }
    const refresh = fields.querySelector('#mm-captcha-refresh');
    if (refresh) refresh.onclick = (e) => { e.preventDefault(); loadCaptcha(); };
    loadCaptcha();
  }

  function startCooldown(sec) {
    state.cooldown = Math.max(1, Math.min(3600, Number(sec) || 60));
    if (state.timer) clearInterval(state.timer);
    const tick = () => {
      const btn = document.getElementById('mm-acc-send');
      if (!btn) { clearInterval(state.timer); return; }
      if (state.cooldown <= 0) {
        btn.textContent = '发送验证码'; btn.disabled = false; btn.style.opacity = '';
        clearInterval(state.timer); return;
      }
      btn.textContent = state.cooldown + 's 后重发';
      btn.disabled = true; btn.style.opacity = '.6';
      state.cooldown--;
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  async function sendCode() {
    const email = (document.getElementById('mm-acc-email').value || '').trim();
    const msg = document.getElementById('mm-acc-msg');
    if (!/^[1-9][0-9]{4,11}@qq\.com$/.test(email)) { msg.textContent = '请输入正确的 QQ 邮箱'; return; }
    const btn = document.getElementById('mm-acc-send');
    btn.disabled = true;
    msg.style.color = '#9fb4b8'; msg.textContent = '发送中…';
    try {
      const r = await api('/api/auth/send-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (r.body && r.body.ok) {
        msg.style.color = '#7ff0cf';
        msg.textContent = '验证码已发送，请查收邮箱（10 分钟内有效）';
        startCooldown(r.body.cooldown || 60);
      } else {
        const map = { invalid_email: '邮箱格式不正确', email_taken: '该邮箱已注册', too_soon: '发送太频繁，请稍后再试', too_many_codes: '半小时内发送次数过多，请稍后再试', too_many_requests: '请求过于频繁', mail_failed: '邮件发送失败，请稍后重试' };
        msg.style.color = '#ffb4a8';
        msg.textContent = map[(r.body && r.body.error) || ''] || '发送失败，请稍后重试';
        if (r.body && r.body.retryAfter) startCooldown(r.body.retryAfter);
        else { btn.disabled = false; btn.style.opacity = ''; }
      }
    } catch {
      msg.style.color = '#ffb4a8'; msg.textContent = '网络错误，请稍后重试'; btn.disabled = false;
    }
  }

  function captchaInput() {
    return (document.getElementById('mm-acc-captcha').value || '').trim();
  }

  async function startReset() {
    const msg = document.getElementById('mm-acc-msg');
    const emailInput = document.getElementById('mm-acc-email');
    const email = (prompt('请输入绑定账号的 QQ 邮箱', emailInput ? emailInput.value : '') || '').trim().toLowerCase();
    if (!/^[1-9][0-9]{4,11}@qq\.com$/.test(email)) { alert('请输入正确的 QQ 邮箱'); return; }
    const s = await api('/api/auth/reset/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!s.body || !s.body.ok) {
      const map = { too_soon: '发送过于频繁，请稍后再试', too_many_codes: '今日次数过多', too_many_requests: '请求过多' };
      alert('发送失败：' + (map[(s.body && s.body.error) || ''] || '请稍后再试'));
      return;
    }
    const code = (prompt('验证码已发送到邮箱（10 分钟内有效），请输入 6 位验证码') || '').trim();
    if (!/^[0-9]{6}$/.test(code)) { alert('验证码格式不正确'); return; }
    const pw1 = prompt('请输入新密码（至少 8 位）');
    if (!pw1) return;
    if (pw1.length < 8) { alert('新密码至少 8 位'); return; }
    const pw2 = prompt('请再次输入新密码以确认');
    if (pw1 !== pw2) { alert('两次密码不一致，请重新操作'); return; }
    const r = await api('/api/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code, password: pw1 }) });
    if (!r.body || !r.body.ok) {
      const map2 = { code_wrong: '验证码错误', code_expired: '验证码已过期', code_required: '请先获取验证码', code_attempts: '错误次数过多，请重新获取', invalid_password: '新密码至少 8 位' };
      alert('重置失败：' + (map2[(r.body && r.body.error) || ''] || '请稍后重试'));
      return;
    }
    if (msg) { msg.style.color = '#7ff0cf'; msg.textContent = '密码已重置，请用新密码登录'; }
    alert('密码已重置成功，所有旧登录已失效。');
  }

  async function submitLogin() {
    if (state.busy) return;
    const email = (document.getElementById('mm-acc-email').value || '').trim();
    const pass = document.getElementById('mm-acc-pass').value || '';
    const msg = document.getElementById('mm-acc-msg');
    if (!/^[1-9][0-9]{4,11}@qq\.com$/.test(email)) { msg.textContent = '请输入正确的 QQ 邮箱'; return; }
    if (!pass) { msg.textContent = '请输入密码'; return; }
    if (!captchaInput()) { msg.textContent = '请输入图形验证码'; return; }
    await doAuth('/api/auth/login', { email, password: pass, captcha: captchaInput(), captchaId: state.captchaId }, msg);
  }

  async function submitRegister() {
    if (state.busy) return;
    const email = (document.getElementById('mm-acc-email').value || '').trim();
    const code = (document.getElementById('mm-acc-code').value || '').trim();
    const pass = document.getElementById('mm-acc-pass').value || '';
    const msg = document.getElementById('mm-acc-msg');
    if (!/^[1-9][0-9]{4,11}@qq\.com$/.test(email)) { msg.textContent = '请输入正确的 QQ 邮箱'; return; }
    if (!/^[0-9]{6}$/.test(code)) { msg.textContent = '请输入 6 位邮箱验证码'; return; }
    if (pass.length < 8) { msg.textContent = '密码至少 8 位'; return; }
    if (!captchaInput()) { msg.textContent = '请输入图形验证码'; return; }
    await doAuth('/api/auth/register', { email, code, password: pass, captcha: captchaInput(), captchaId: state.captchaId }, msg);
  }

  async function doAuth(path, body, msg) {
    state.busy = true;
    msg.style.color = '#9fb4b8'; msg.textContent = '处理中…';
    try {
      const r = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.body || !r.body.ok) {
        const map = {
          bad_credentials: '邮箱或密码错误', email_taken: '该邮箱已注册', invalid_email: '邮箱格式不正确',
          invalid_password: '密码需 8 位以上', invalid_nickname: '昵称不合法（1~16 字）', invalid_code: '验证码格式不正确',
          code_required: '请先获取验证码', code_expired: '验证码已过期，请重新获取', code_wrong: '邮箱验证码错误',
          code_attempts: '验证码错误次数过多，请重新获取', too_many_requests: '操作过于频繁，请稍后再试',
          captcha_wrong: '图形验证码错误',
        };
        msg.style.color = '#ffb4a8';
        msg.textContent = map[(r.body && r.body.error) || ''] || '操作失败，请稍后重试';
        loadCaptcha();
        return;
      }
      state.user = r.body.user;
      state.guest = false;
      window.__SP_ADMIN_TOKEN = r.body.adminToken || null;
      window.__SP_ACCOUNT_TOKEN = r.body.userToken || null;
      try { window.dispatchEvent(new Event('sp-account-token')); } catch { /* ignore */ }
      try { if (r.body.token) localStorage.setItem('mm.sid', r.body.token); } catch { /* 忽略 */ }
      pullPrefs();
      msg.textContent = '';
      render();
    } catch {
      msg.style.color = '#ffb4a8'; msg.textContent = '网络错误，请稍后重试';
    } finally {
      state.busy = false;
    }
  }

  function render() {
    // 无论当前在哪个界面，都把账号信息暴露给游戏（房间/协议界面显示同一四位代码）
    window.__SP_ACCOUNT_USER = state.user ? state.user.name : null;
    window.__SP_ACCOUNT_TAG = state.user && state.user.tag ? String(state.user.tag) : null;
    window.__SP_ACCOUNT_ROLE = state.user && state.user.role ? String(state.user.role) : null;
    // 角色是判定「管理员 / 服主」的唯一前端依据（房间免销毁、维护开关放行都用它）。
    // 它可能比 sp-account-token 更晚写入，所以单独派发一次，让游戏侧重握手补身份。
    // render() 会被反复调用，只在角色真的变化时派发，避免触发无意义的重复握手。
    try {
      if (window.__SP_LAST_DISPATCHED_ROLE !== window.__SP_ACCOUNT_ROLE) {
        window.__SP_LAST_DISPATCHED_ROLE = window.__SP_ACCOUNT_ROLE;
        window.dispatchEvent(new Event('sp:account-changed'));
      }
    } catch { /* ignore */ }
    ensureSyncHint();
    renderSyncHint();
    try {
      if (state.user && state.user.tag) {
        localStorage.setItem('mm.tag', String(state.user.tag));
        if (state.user.nickname) localStorage.setItem('mm.name', state.user.nickname);
      }
    } catch { /* 隐私模式 */ }
    const wrapEl = document.getElementById('mm-acc-wrap');
    if (!titleScreen()) { if (wrapEl) wrapEl.style.display = 'none'; return; }
    if (wrapEl) wrapEl.style.display = '';
    const form = document.getElementById('mm-acc-form');
    const guestRow = document.getElementById('mm-acc-guest-row');
    const logged = document.getElementById('mm-acc-logged');
    const hint = document.getElementById('mm-acc-guest-hint');
    const callsign = findCallsign();
    if (!form || !callsign) return;
    const box = fieldBoxOf(callsign);
    const label = fieldLabelOf(callsign);
    // 用 html class 持久控制显隐（游戏重渲染也不会把旧界面放出来）
    document.documentElement.classList.add('mm-acc-ready');
    document.documentElement.classList.toggle('mm-acc-login', !state.user && !state.guest);

    if (state.user) {
      setLabelVisible(label, true);
      const needName = !state.user.nickname;
      form.style.display = 'none';
      guestRow.style.display = 'none';
      logged.style.display = needName ? 'none' : 'flex';
      const who = document.getElementById('mm-acc-who');
      if (who) who.textContent = '';
      renderSyncLine();
      // 有权限的账号显示「管理后台」入口
      const adm = document.getElementById('mm-acc-admin');
      if (adm) adm.style.display = (state.user.role && state.user.role !== 'player') ? 'inline-block' : 'none';
      if (box) box.style.display = '';
      callsign.style.display = '';
      if (needName) {
        // 首次使用：可编辑代号，开始前自动保存并追加 #代码
        hint.style.display = 'flex';
        const hintText = hint.querySelector('span');
        if (hintText) hintText.textContent = '首次使用：请输入博士代号';
        callsign.readOnly = false;
        callsign.style.opacity = '';
        callsign.maxLength = 8;
        callsign.placeholder = '输入你的博士代号（最多 8 字）';
        setStartEnabled(true);
      } else {
        hint.style.display = 'none';
        callsign.readOnly = true;
        callsign.style.opacity = '.75';
        callsign.placeholder = '输入你的代号（最多 12 字）';
        const nm = String(state.user.nickname || state.user.titleName || state.user.name || '').replace(/#\d{4}\s*$/, '').trim();
        if (nm && document.activeElement !== callsign && callsign.value !== nm) {
          callsign.value = nm;
          // 同步给游戏自身的状态，避免它按空名字渲染回去
          try {
            callsign.dispatchEvent(new Event('input', { bubbles: true }));
            callsign.dispatchEvent(new Event('change', { bubbles: true }));
          } catch { /* 忽略 */ }
        }
        setStartEnabled(true);
      }
      return;
    }

    logged.style.display = 'none';
    if (state.guest) {
      setLabelVisible(label, true);
      form.style.display = 'none';
      guestRow.style.display = 'none';
      hint.style.display = 'flex';
      if (box) box.style.display = '';
      callsign.style.display = '';
      callsign.readOnly = false;
      callsign.style.opacity = '';
      setStartEnabled(true);
    } else {
      // 登录/注册态：连「博士代号 CALLSIGN」标题一起隐藏
      setLabelVisible(label, false);
      form.style.display = 'flex';
      guestRow.style.display = 'flex';
      hint.style.display = 'none';
      if (box) box.style.display = 'none';
      setStartEnabled(false);
    }
  }

  function isAccountName(v) {
    return typeof v === 'string' && /^.+[#][0-9]{4}$/.test(v.trim());
  }

  // 退出登录/未登录时，不保留任何账号态数据
  function clearAccountCache() {
    window.__SP_ACCOUNT_TOKEN = null;
    try {
      const n = localStorage.getItem('sp.name');
      if (n && isAccountName(n)) localStorage.removeItem('sp.name');
      for (const k of ['sp.tokens', 'sp.token', 'sp.tokenWelcome', 'sp.lastRoom', 'mm.tag', 'mm.name', 'mm.sid']) localStorage.removeItem(k);
      // 账号云端的偏好也一并清掉，避免退出后仍以缓存形式显示
      for (const key of Object.values(PREF_MAP)) if (key !== 'mm.annDismissed') localStorage.removeItem(key);
      // 公告已读（mm.annDismissed）保留为设备级缓存：未登录 / 退出后仍然生效
      sessionStorage.removeItem('sp.token');
    } catch { /* 隐私模式 */ }
  }

  // ---------------------------------------------------------------- 账号数据云同步
  const PREF_MAP = {
    loadout: 'sp.pref.loadout',
    ownership: 'sp.pref.ownership',
    diy: 'sp.pref.diy',
    skins: 'sp.pref.skins',
    cosmetics: 'sp.pref.cosmetics',
    notices: 'sp.pref.notices-seen',
    stats: 'sp.pref.stats',
    annSeen: 'mm.annDismissed',
    identity: 'sp.name',
    // 名片干员（ui/seatArt.js 的 CARD_PREF 'room.card'）：玩家选的那张立绘。
    // 以前不在云同步里，只存在浏览器本地 —— 换设备/清缓存就丢，玩家反馈要保存在账号里。
    // 注意：store.js 的 loadPref/savePref 会自动加 'sp.pref.' 前缀，
    // 所以真实的 localStorage 键是 'sp.pref.room.card'，这里必须写全名。
    card: 'sp.pref.room.card',
  };
  const KEY_DOMAIN = Object.fromEntries(Object.entries(PREF_MAP).map(([d, k]) => [k, d]));
  const prefVersions = {};
  const pushTimers = {};
  let syncReady = false;
  let applyingRemote = false;
  // 同步状态：idle | syncing | error
  let syncState = 'idle';
  let lastSyncAt = 0;
  let syncMinUntil = 0;
  function setSyncState(s) {
    if (s === 'syncing') {
      syncState = 'syncing';
      syncMinUntil = Date.now() + 700; // 至少显示 0.7 秒，避免一闪而过
      renderSyncLine();
      return;
    }
    if (s === 'idle') {
      lastSyncAt = Date.now();
      const wait = Math.max(0, syncMinUntil - Date.now());
      if (wait > 0) { setTimeout(() => { syncState = 'idle'; renderSyncLine(); }, wait); }
      else { syncState = 'idle'; renderSyncLine(); }
      return;
    }
    syncState = s;
    renderSyncLine();
  }
  function renderSyncLine() {
    const el = document.getElementById('mm-acc-sync');
    if (!el) return;
    if (!state.user) { el.textContent = ''; return; }
    if (syncState === 'syncing') { el.style.color = '#9fb4b8'; el.textContent = '同步中…'; return; }
    if (syncState === 'error') { el.style.color = '#ffb4a8'; el.textContent = '同步失败'; return; }
    const t = new Date(lastSyncAt || Date.now());
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    el.style.color = '#7ff0cf';
    el.textContent = '已同步 · ' + hh + ':' + mm;
  }

  /** 空载荷：null / {} / [] （用于判断“云端空白”和“本地没东西可合并”） */
  const isEmptyPref = (v) => v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);

  async function pullPrefs() {
    try {
      const r = await api('/api/prefs');
      if (!r.body || !r.body.ok) return;
      const domains = r.body.domains || {};
      const merge = {};
      const recover = [];
      applyingRemote = true;
      for (const [domain, key] of Object.entries(PREF_MAP)) {
        const rec = domains[domain];
        let localVal = null;
        try { const raw = localStorage.getItem(key); localVal = raw == null ? null : JSON.parse(raw); } catch { localVal = null; }
        if (rec) {
          prefVersions[domain] = rec.version;
          // 云端是空白、本机有数据：保留本机并回填云端（避免换设备/清缓存后看到空白）
          if ((domain === 'loadout' || domain === 'skins') && isEmptyPref(rec.payload) && !isEmptyPref(localVal)) {
            recover.push(domain);
            continue;
          }
          try { localStorage.setItem(key, JSON.stringify(rec.payload)); } catch { /* 忽略 */ }
        } else if (localVal != null && !isEmptyPref(localVal)) {
          // 只把非空的本地数据合并上云；空数据不该生成一条空白记录
          merge[domain] = { payload: localVal };
        }
      }
      applyingRemote = false;
      if (Object.keys(merge).length) {
        const m = await api('/api/prefs/merge', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domains: merge }),
        });
        const res = (m.body && m.body.result) || {};
        for (const [domain, v] of Object.entries(res)) if (v && v.version) prefVersions[domain] = v.version;
      }
      syncReady = true;
      for (const domain of recover) schedulePush(domain);
    } catch { /* 离线时保持本地 */ }
  }

  function schedulePush(domain) {
    if (applyingRemote) return;
    if (!syncReady || !state.user) return;
    clearTimeout(pushTimers[domain]);
    pushTimers[domain] = setTimeout(async () => {
      const key = PREF_MAP[domain];
      if (!key) return;
      const raw = localStorage.getItem(key);
      if (raw == null) return;
      let payload;
      try { payload = JSON.parse(raw); } catch { /* 非 JSON */ return; }
      try {
        setSyncState('syncing');
        const r = await api('/api/prefs/' + domain, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload, baseVersion: prefVersions[domain] || 0 }),
        });
        if (r.status === 200 && r.body && r.body.ok) { prefVersions[domain] = r.body.version; setSyncState('idle'); }
        else if (r.status === 409 && r.body && r.body.server) {
          prefVersions[domain] = r.body.server.version;
          // 应用服务端版本时不触发再次上传（否则会把刚写回的数据重复 PUT、白涨版本）
          applyingRemote = true;
          try { localStorage.setItem(key, JSON.stringify(r.body.server.payload)); } finally { applyingRemote = false; }
          setSyncState('idle');
        } else setSyncState('error');
      } catch { setSyncState('error'); }
    }, 800);
  }

  // 监听本地写入：账号登录后，账号域数据自动同步到云端
  if (!window.__mmPrefHook) {
    window.__mmPrefHook = true;
    const rawSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      rawSet.call(this, key, value);
      try {
        if (!applyingRemote && this === localStorage && KEY_DOMAIN[key] && state.user) schedulePush(KEY_DOMAIN[key]);
      } catch { /* 忽略 */ }
    };
  }

  async function boot() {
    // hello 里只发纯昵称：四位代码只用于 DOCTOR # 显示，不进入玩家名字
    if (!window.__mmWsTag) {
      window.__mmWsTag = true;
      const rawSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string' && data.indexOf('"hello"') >= 0) {
            const msg = JSON.parse(data);
            if (msg && msg.t === 'hello') {
              let dirty = false;
              if (typeof msg.name === 'string') {
                const plain = msg.name.replace(/#[0-9]{4}\s*$/, '').trim();
                if (plain && plain !== msg.name) { msg.name = plain.slice(0, 12); dirty = true; }
              }
              const tag = window.__SP_ACCOUNT_TAG;
              if (tag && /^[0-9]{4}$/.test(tag) && msg.tag !== tag) { msg.tag = tag; dirty = true; }
              if (dirty) data = JSON.stringify(msg);
            }
          }
        } catch { /* 原样发送 */ }
        return rawSend.call(this, data);
      };
    }
    // 同步锁定：在 /me 返回前先隐藏代号框/开始按钮，避免页面先显示旧界面被点击进入
    const cs0 = findCallsign();
    if (cs0) {
      setLabelVisible(fieldLabelOf(cs0), false);
      const b0 = fieldBoxOf(cs0);
      if (b0) b0.style.display = 'none';
    }
    setStartEnabled(false);
    // 认证状态未知时拦截「开始」点击（连点也进不去）
    document.addEventListener('click', (e) => {
      if (state.authReady) return;
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (btn && /开始/.test((btn.textContent || '').trim())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    // 旧缓存自检：若拿到的大厅脚本还是旧版（不含 accountTag），强制刷新一次
    try {
      const probe = await fetch('/js/screens/lobby.js', { cache: 'no-store' });
      const txt = await probe.text();
      if (!txt.includes('accountTag') && !sessionStorage.getItem('mm.reload1')) {
        sessionStorage.setItem('mm.reload1', '1');
        location.reload();
        return;
      }
      sessionStorage.removeItem('mm.reload1');
    } catch { /* 忽略 */ }

    try {
      const r = await api('/api/auth/me');
      if (r.status === 200 && r.body && r.body.user) {
        state.user = r.body.user;
        window.__SP_ADMIN_TOKEN = r.body.adminToken || null;
        window.__SP_ACCOUNT_TOKEN = r.body.userToken || null;
        try { window.dispatchEvent(new Event('sp-account-token')); } catch { /* ignore */ }
        pullPrefs();
        // 账号代码持久化：大厅/房间的 DOCTOR # 直接读它
        try {
          if (state.user.tag) localStorage.setItem('mm.tag', String(state.user.tag));
          if (state.user.nickname) localStorage.setItem('mm.name', state.user.nickname);
          if (state.user.nickname) localStorage.setItem('sp.name', state.user.nickname);
        } catch { /* 隐私模式 */ }
      } else clearAccountCache();
    } catch { clearAccountCache(); }
    state.authReady = true;
    const anchor = anchorOf(findCallsign());
    if (anchor && !document.getElementById('mm-acc-wrap')) build(anchor);
    render();

    // 首次设置代号：点「开始」前自动保存并追加 #代码
    document.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || !/开始/.test((btn.textContent || '').trim())) return;
      if (state.user && state.user.nickname) {
        const inp2 = findCallsign();
        const nm2 = String(state.user.nickname || state.user.titleName || state.user.name || '').replace(/#\d{4}\s*$/, '').trim();
        if (inp2 && nm2 && inp2.value !== nm2) inp2.value = nm2;
        try {
          if (nm2) localStorage.setItem('sp.name', nm2);      // 标题/大厅只显示昵称
          if (state.user.tag) localStorage.setItem('mm.tag', String(state.user.tag));
        } catch { /* 隐私模式 */ }
        return;
      }
      if (!state.user) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const input = findCallsign();
      const val = (input && input.value ? input.value : '').trim();
      if (val.length < 1 || val.length > 8) { alert('请输入 1~8 字的博士代号'); if (input) input.focus(); return; }
      const r = await api('/api/auth/set-name', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: val }),
      });
      if (!r.body || !r.body.ok) { alert('代号保存失败，请稍后重试'); return; }
      state.user = r.body.user;
      if (input) input.value = state.user.titleName || state.user.nickname || state.user.name;
      window.__SP_ACCOUNT_TOKEN = r.body.userToken || window.__SP_ACCOUNT_TOKEN || null;
      window.__SP_ADMIN_TOKEN = r.body.adminToken || window.__SP_ADMIN_TOKEN || null;
      window.__SP_ACCOUNT_TAG = state.user && state.user.tag ? String(state.user.tag) : null;
      if (state.user && state.user.tag) {
        try { localStorage.setItem('mm.tag', String(state.user.tag)); } catch { /* ignore */ }
        try { localStorage.setItem('mm.name', state.user.nickname || ''); } catch { /* ignore */ }
        try { localStorage.setItem('sp.name', state.user.nickname || ''); } catch { /* ignore */ }
        try { window.dispatchEvent(new Event('sp-account-token')); } catch { /* ignore */ }
      }
      render();
      btn.click();
    }, true);

    setInterval(() => {
      const a2 = anchorOf(findCallsign());
      if (a2 && !document.getElementById('mm-acc-wrap')) { build(a2); render(); }
      else render();
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
