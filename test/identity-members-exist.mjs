// 守卫：identity.xxx 调用的成员必须真实存在于 net.js 的 createIdentity 里
//
//   node test/identity-members-exist.mjs
//
// 事故（2026-10-27，玩家反馈「换设备点恢复对局，一直卡在正在进入模拟…」）：
//   accountObserver.js 的 adoptAccountSeat 写了 `identity.adopt(msg.token)`，
//   而 createIdentity() 返回的对象**根本没有 adopt 这个成员**。
//   于是每次接管都抛 TypeError → token 从未被采用 → 不重连 →
//   服务端不会再推 room.state → 前端永远停在「正在进入模拟」。
//
// 这类错误语法检查发现不了（合法 JS，只是运行时 undefined），
// 所以专门写一个静态检查：把 identity 用在哪些成员上，和 net.js 实际导出的比对。
import fs from 'node:fs';
import path from 'node:path';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const net = fs.readFileSync('public/js/net.js', 'utf8');

// ---- 1) 取出 createIdentity() 返回对象的成员名 ----
const start = net.indexOf('  return {\n    tabId,');
if (start < 0) { console.log('找不到 createIdentity 的 return 对象'); process.exit(1); }
// 从 return { 开始按大括号配对找到结尾
let i = net.indexOf('{', start);
let depth = 0;
let end = -1;
for (let j = i; j < net.length; j++) {
  const c = net[j];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
}
const objSrc = net.slice(i, end + 1);
// 成员形如 `tabId,` / `saveToken(token) {` / `loadName: () =>` / `recoverable() {`
const members = new Set();
for (const m of objSrc.matchAll(/^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:[,(:]|\s*\{)/gm)) {
  members.add(m[1]);
}
// 简写属性（`tabId,` / `rememberMatch,`）
for (const m of objSrc.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*,\s*$/gm)) members.add(m[1]);

console.log('=== identity 实际成员 ===\n');
console.log('  ' + [...members].sort().join(', ') + '\n');
check('抓到的成员数量合理（> 10）', members.size > 10, `实际 ${members.size}`);

// ---- 2) 收集全仓 identity.xxx 的使用 ----
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|vendor/.test(e.name)) continue;
      walk(full, out);
    } else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const files = walk('public/js');
const used = new Map(); // member -> [file:line]
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // 剥掉注释，避免注释里的示例被当真
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  const lines = code.split('\n');
  lines.forEach((line, idx) => {
    // 排除 `identity.js` 这种文件名（前面紧跟路径分隔符或引号就不算成员访问）
    for (const m of line.matchAll(/(?<![/\w'"`-])identity\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (name === 'js' || name === 'mjs' || name === 'json') continue;
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(`${f.replace(/\\/g, '/')}:${idx + 1}`);
    }
  });
}

console.log('=== 使用点比对 ===\n');
const missing = [];
for (const [name, where] of [...used].sort()) {
  const ok = members.has(name);
  if (!ok) missing.push(`${name} ← ${where.join(', ')}`);
  console.log(`  ${ok ? '✓' : '✗'} identity.${name}${ok ? '' : '   ★ 不存在！'}  (${where.length} 处)`);
}

check('★ 所有 identity.xxx 调用都有对应成员', missing.length === 0,
  missing.length ? '\n     ' + missing.join('\n     ') : '');

// ---- 3) 特别点名这次踩到的 adopt ----
console.log('\n=== 事故点回归 ===\n');
check('★ adoptAccountSeat 不再调用不存在的 identity.adopt',
  !/identity\.adopt\s*\(/.test(fs.readFileSync('public/js/ui/accountObserver.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')));
check('adoptAccountSeat 改用 identity.saveToken',
  /function adoptAccountSeat[\s\S]{0,1200}?identity\.saveToken\(/.test(fs.readFileSync('public/js/ui/accountObserver.js', 'utf8')));
check('接管后重新连接（net.connect）',
  /function adoptAccountSeat[\s\S]{0,1500}?net\.connect\(\)/.test(fs.readFileSync('public/js/ui/accountObserver.js', 'utf8')));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
