// 立绘选择跟随账号（room.card 的服务端持久化）
//
// 现象：玩家手动选过的立绘，换设备 / 清缓存后变回默认。
//
// 根因（两处，都只在服务端）：
//   1. account.cjs 的 DOMAINS 白名单里没有 'card' → PUT /api/prefs/card 一直回
//      404 unknown_domain，立绘永远存不进账号。前端 PREF_MAP 早有 card，服务端漏了。
//   2. validatePrefPayload 的通用规则要求 payload 是对象，而 card 的 payload 是
//      charId 字符串（'' = 默认立绘）→ 即便加了白名单也会 400 invalid_payload。
//   3. 读端一律 JSON.parse(row.payload)，裸字符串落库时会抛异常，把整个
//      GET /api/prefs 变成 500（所有域一起挂）。
//
//   node test/card-pref-sync.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const acct = fs.readFileSync('matchmaker/account.cjs', 'utf8');
const title = fs.readFileSync('matchmaker/public/account-title.js', 'utf8');
const seatArt = fs.readFileSync('public/js/ui/seatArt.js', 'utf8');
const store = fs.readFileSync('public/js/store.js', 'utf8');

console.log('=== 前端：键名与映射 ===\n');
check('seatArt 的 CARD_PREF 是 room.card', /export const CARD_PREF = 'room\.card'/.test(seatArt));
check('loadPref/savePref 会加 sp.pref. 前缀',
  /localStorage\?\.getItem\(`sp\.pref\.\$\{key\}`\)/.test(store));
check('★ PREF_MAP 里有 card 域，且写全名 sp.pref.room.card',
  /card: 'sp\.pref\.room\.card'/.test(title));
check('KEY_DOMAIN 由 PREF_MAP 反推（card 自动被监听）',
  /const KEY_DOMAIN = Object\.fromEntries\(Object\.entries\(PREF_MAP\)/.test(title));
check('localStorage 写入被 hook 后自动 schedulePush',
  /KEY_DOMAIN\[key\] && state\.user\) schedulePush\(KEY_DOMAIN\[key\]\)/.test(title));

console.log('\n=== 服务端：白名单与校验 ===\n');
const domainsLine = acct.match(/const DOMAINS = new Set\(\[([\s\S]*?)\]\);/);
check('找到 DOMAINS 白名单', !!domainsLine);
check('★ 白名单包含 card', /'card'/.test(domainsLine ? domainsLine[1] : ''));
check('★ validatePrefPayload 对 card 放行字符串',
  /if \(domain === 'card'\) return typeof payload === 'string'/.test(acct));
check('card 的 payload 长度上限', /if \(domain === 'card'\) return typeof payload === 'string' && payload\.length <= 64/.test(acct));

console.log('\n=== 读端容错（裸字符串不会让整个 prefs 挂掉）===\n');
check('★ 有 decodePrefPayload 兜底函数', /function decodePrefPayload\(raw\)/.test(acct));
check('parse 失败时退回原字符串', /try \{ return JSON\.parse\(raw\); \} catch \{ return raw; \}/.test(acct));
check('GET /api/prefs 用 decodePrefPayload',
  !/JSON\.parse\(r\.payload\)/.test(acct) && /decodePrefPayload\(r\.payload\)/.test(acct));
check('版本冲突回包用 decodePrefPayload', /decodePrefPayload\(now\[0\]\.payload\)/.test(acct));

console.log('\n=== 行为模拟 ===\n');
{
  const decodePrefPayload = (raw) => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  // 正常写入：JSON.stringify('char_291_aglina') = '"char_291_aglina"'
  check('正常落库（带引号）解码回 charId', decodePrefPayload('"char_291_aglina"') === 'char_291_aglina');
  // 裸字符串落库（老数据 / 手工写）
  check('★ 裸字符串落库也能解码（不再 500）', decodePrefPayload('char_291_aglina') === 'char_291_aglina');
  // 对象型域不受影响
  check('对象型域仍然正常', JSON.stringify(decodePrefPayload('{"entries":{}}')) === '{"entries":{}}');
  check('空字符串（默认立绘）', decodePrefPayload('""') === '');
  // 对照：改造前会抛异常
  let threw = false;
  try { JSON.parse('char_291_aglina'); } catch { threw = true; }
  check('改造前确实会抛异常（复现原 bug）', threw);
}

console.log('\n=== 端到端脚本存在（跨设备验证）===\n');
check('有 tools/_verify-card-sync.mjs 做真实跨设备验证',
  fs.existsSync('tools/_verify-card-sync.mjs') || fs.existsSync('../tools/_verify-card-sync.mjs'));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
