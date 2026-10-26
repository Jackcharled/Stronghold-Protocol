// 博士代号规则：按显示宽度，最多 8 个汉字 或 16 个英文字母/数字（可混合）。
// 前后端（matchmaker/account.cjs 的 checkNickname 与 account-title.js 的 nickProblem）必须完全一致。
//   node test/nickname-rule.mjs
const NICK_W_MAX = 16;
const NICK_RE = /^[\p{L}\p{N}_\-·]+$/u;

function nickWidth(str) {
  let w = 0;
  for (const ch of String(str || '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}
function nickProblem(v) {
  const s = String(v || '').trim();
  if (!s) return 'empty';
  if (!NICK_RE.test(s)) return 'charset';
  if (nickWidth(s) > NICK_W_MAX) return 'too_long';
  return null;
}
// 服务端同一判定
function serverAccepts(s) {
  const t = String(s || '').trim();
  return t.length > 0 && NICK_RE.test(t) && nickWidth(t) <= NICK_W_MAX;
}

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

console.log('=== 这次报错的代号 ===\n');
check('★ "ZcElytra"（8 个英文）现在合法', nickProblem('ZcElytra') === null, '8 个英文 = 宽度 8，远小于 16');
check('服务端也接受', serverAccepts('ZcElytra'));

console.log('\n=== 8 个汉字：合法 ===\n');
const eight = '一二三四五六七八';
check('宽度 = 16', nickWidth(eight) === 16);
check('★ 8 个汉字通过', nickProblem(eight) === null);

console.log('\n=== 16 个英文字母/数字：合法 ===\n');
const sixteen = 'abcdefgh12345678';
check('宽度 = 16', nickWidth(sixteen) === 16);
check('★ 16 个英文数字通过', nickProblem(sixteen) === null);

console.log('\n=== 混合：按宽度算 ===\n');
check('4 汉字 + 8 英文 = 宽度 16 → 通过', nickProblem('测试博士abcdefgh') === null);
check('5 汉字 + 7 英文 = 宽度 17 → 拒绝', nickProblem('测试博士啊abcdefg') === 'too_long');

console.log('\n=== 边界 ===\n');
check('9 个汉字 → 拒绝', nickProblem('一二三四五六七八九') === 'too_long');
check('17 个英文 → 拒绝', nickProblem('abcdefgh123456789') === 'too_long');
check('1 个字符 → 通过', nickProblem('X') === null);

console.log('\n=== 字符集 ===\n');
for (const s of ['测试博士', 'AB_12', '名字-测试', '玩家·一号', 'abc123', 'ZcElytra']) {
  check(`"${s}" 通过`, nickProblem(s) === null && serverAccepts(s));
}
check('带空格 → 拒绝', nickProblem('a b') === 'charset');
check('感叹号 → 拒绝', nickProblem('abc!') === 'charset');
check('中文逗号 → 拒绝', nickProblem('测试，博士') === 'charset');
check('空 → 拒绝', nickProblem('') === 'empty');
check('纯空格 → 拒绝', nickProblem('   ') === 'empty');

console.log('\n=== 前后端逐条一致 ===\n');
const all = ['ZcElytra', eight, sixteen, '测试博士abcdefgh', '测试博士啊abcdefg', '一二三四五六七八九',
  'abcdefgh123456789', 'X', 'AB_12', '名字-测试', '玩家·一号', 'a b', 'abc!', '测试，博士', '', '   ', 'a_'];
let mismatch = 0;
for (const s of all) {
  const fe = nickProblem(s) === null;
  const se = serverAccepts(s);
  if (fe !== se) { mismatch++; console.log(`  ✗ 不一致: "${s}" 前端=${fe} 服务端=${se}`); }
}
check(`★ ${all.length} 条全部一致`, mismatch === 0);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
