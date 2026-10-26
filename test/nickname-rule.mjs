// 博士代号校验：前端提示必须与服务端 matchmaker/account.cjs 的 /api/auth/set-name 完全一致。
//   node test/nickname-rule.mjs
const NICK_MAX = 7;
const NICK_RE = /^[\p{L}\p{N}_\-·]+$/u;

function nickProblem(v) {
  const s = String(v || '').trim();
  if (!s) return 'empty';
  if ([...s].length > NICK_MAX) return 'too-long:' + [...s].length;
  if (!NICK_RE.test(s)) return 'bad-char';
  return null;
}
// 服务端的原始判定（逐字复制 matchmaker/account.cjs:654）
function serverAccepts(nickname) {
  return !(nickname.length < 1 || nickname.length > 7 || !/^[\p{L}\p{N}_\-·]+$/u.test(nickname));
}

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

console.log('=== 这次报错的代号 ===\n');
check('"ZcElytra"（8 字符）前端就会拦下，不再发请求', nickProblem('ZcElytra') === 'too-long:8',
  '→ 以前前端放行 1~8，服务端只收 1~7，于是只报「保存失败，请稍后重试」');
check('服务端也拒绝它（口径一致）', serverAccepts('ZcElytra') === false);

console.log('\n=== 合法代号必须通过 ===\n');
for (const s of ['ZcElytr', '测试博士', 'AB_12', '名字-测试', 'X', '玩家·一号', 'abc123']) {
  check(`"${s}" 通过`, nickProblem(s) === null && serverAccepts(s));
}

console.log('\n=== 非法代号必须被拦，且原因说清楚 ===\n');
check('空字符串 → 提示输入', nickProblem('') === 'empty');
check('纯空格 → 提示输入', nickProblem('   ') === 'empty');
check('带空格 → 字符不合法', nickProblem('a b') === 'bad-char');
check('特殊符号 ! → 字符不合法', nickProblem('abc!') === 'bad-char');
check('中文标点 → 字符不合法', nickProblem('测试，博士') === 'bad-char');
check('超长（8 个汉字）→ 太长', nickProblem('一二三四五六七八') === 'too-long:8');

console.log('\n=== 前后端口径完全一致（逐条对比）===\n');
const all = ['ZcElytra', 'ZcElytr', '测试博士', 'AB_12', '名字-测试', 'X', '玩家·一号', 'a b', 'abc!', '一二三四五六七八', '😀😀', 'a_'];
let mismatch = 0;
for (const s of all) {
  const fe = nickProblem(s);
  const se = serverAccepts(s);
  const agree = (fe === null) === se;
  if (!agree) { mismatch++; console.log(`  ✗ 不一致: "${s}" 前端=${fe} 服务端=${se}`); }
}
check('★ 前端放行 == 服务端接受（无一条不一致）', mismatch === 0);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
